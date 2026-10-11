import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { summarize, type SampleSummary } from './acceptance-stats';
import { runInNewContext } from 'node:vm';
import {
  readSealedTrace,
  qualify,
  PAYLOAD_BYTES,
  PAYLOAD_SHA256,
  type TraceExpected,
} from './terminal-causal-trace';

/** Test-only measurement of delivered IPC receipt and final parsed buffers.
 * The delivery observer never attaches, acknowledges or modifies flow control;
 * it provides no independent PTY/main loss attribution. */

const execFileAsync = promisify(execFile);

const POLL_MS = 4; // the plan's stated in-page quantization

/** The app surfaces this kit waits on, plus the test-only accumulator. */
interface ProbeWindow {
  __condashXterms?: Map<
    string,
    {
      rows: number;
      cols: number;
      options: { scrollback?: number };
      element?: HTMLElement;
      buffer: {
        active: {
          type: string;
          length: number;
          baseY: number;
          getLine(y: number): { translateToString(trim?: boolean): string } | undefined;
        };
      };
    }
  >;
  __condashRepaints?: { started: number; settled: number };
  __condashTermTransport?: {
    bySid: Map<
      string,
      {
        bytes: number;
        chunks: number;
        text: string;
        observerMs: number;
        overflow: boolean;
        receipt?: PayloadReceiptWatch;
        causal?: CausalPayloadWatch;
      }
    >;
    dispose(): void;
  };
  condash: {
    termWrite(id: string, data: string): Promise<void>;
    onTermData(cb: (msg: { id: string; data: string }) => void): () => void;
    termGeometry(id: string): Promise<{ rows: number; cols: number } | null>;
  };
}

interface PayloadReceiptWatch {
  budget: number;
  triggerAt: number;
  pending: string;
  inPayload: boolean;
  payloadBytes: number;
  receiptAt: number | null;
  completionAt: number | null;
  marks: { bytes: number; elapsedMs: number | null }[];
}

type CausalObservations = Parameters<typeof qualify>[1];
type CausalAttempt = CausalObservations['attempts'][number] & {
  settledMs?: number;
  settlementValid?: boolean;
  startedBaseline?: number;
};
interface CausalPayloadWatch {
  source: string;
  echo: string | null;
  arm: TraceExpected['arm'];
  payloadBytes: number;
  chunks: string[];
  pending: string;
  rawPending: string;
  inPayload: boolean;
  trailer: string;
  done: boolean;
  error: string | null;
  callbacks: CausalObservations['callbacks'];
  attempts: CausalAttempt[];
  unexpected: string[];
  lastBoundary: number;
  observerMs: number;
  observerCalls: number;
  ackPollMs: number;
  ackPollCalls: number;
  owner: unknown;
  ownerLost: boolean;
  hiddenOwnerAppeared: boolean;
  next: number;
  pendingAttempt: CausalAttempt | null;
  timers: ReturnType<typeof setInterval>[];
  launch(): void;
}

export interface ProbeOutcome {
  firstMs: number;
  settledMs?: number;
  timedOut: boolean;
  stage: 'first-frame' | 'settled';
  /** Only on timeout: the viewport rows at timeout, so a failed sample is
   *  self-diagnosing (ACK scrolled off? term absent? wrong content?). */
  viewportOnTimeout?: string[];
  load?: {
    budget: number;
    beforePayloadBytes: number;
    atAckPayloadBytes: number;
    beforeDeliveredBytes: number;
    atAckDeliveredBytes: number;
    beforeDone: boolean;
    atAckDone: boolean;
  };
}

// The arm body must be fully self-contained (no free variables): Playwright
// serializes the function alone, so the SAME literal serves both the init
// script (where document.body may not exist yet — hence the DOMContentLoaded
// retry, the hydrate-geometry pattern) and the current-document evaluate.
const armSurfaces = (): void => {
  const w = window as unknown as ProbeWindow & { document: Document };
  const install = (): void => {
    if (!w.document.body) return;
    w.document.body.setAttribute('data-test-xterm-registry', '');
    if (w.__condashTermTransport || !w.condash) return;
    const bySid = new Map<
      string,
      {
        bytes: number;
        chunks: number;
        text: string;
        observerMs: number;
        overflow: boolean;
        receipt?: PayloadReceiptWatch;
        causal?: CausalPayloadWatch;
      }
    >();
    const unsubscribe = w.condash.onTermData(({ id, data }) => {
      const started = performance.now();
      let entry = bySid.get(id);
      if (!entry) {
        entry = { bytes: 0, chunks: 0, text: '', observerMs: 0, overflow: false };
        bySid.set(id, entry);
      }
      entry.bytes += data.length;
      entry.chunks += 1;
      // The burst is ~3.9 MB; a soft cap keeps a runaway fixture from growing
      // the page without bound while never truncating a planned census.
      if (entry.text.length + data.length <= 32_000_000) entry.text += data;
      else entry.overflow = true;
      const receipt = entry.receipt;
      if (receipt && !entry.causal && receipt.completionAt === null) {
        const lines = (receipt.pending + data).split('\n');
        receipt.pending = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (line === 'PAYLOAD-BEGIN') {
            receipt.inPayload = true;
            continue;
          }
          if (!receipt.inPayload) continue;
          if (/^PAYLOAD-END \d+ \d+$/.test(line)) {
            receipt.completionAt = started;
            receipt.inPayload = false;
            break;
          }
          if (/^ACK P\d+\b/.test(line)) continue;
          receipt.payloadBytes += line.length + 1;
          for (const mark of receipt.marks) {
            if (mark.elapsedMs === null && receipt.payloadBytes >= mark.bytes)
              mark.elapsedMs = started - receipt.triggerAt;
          }
          if (receipt.receiptAt === null && receipt.payloadBytes >= receipt.budget)
            receipt.receiptAt = started;
        }
      }
      const causal = entry.causal;
      if (causal && receipt && !causal.error) {
        if (causal.arm === 'active-census' && w.__condashXterms?.get(id) !== causal.owner)
          causal.ownerLost = true;
        if (causal.arm === 'hidden-burst-idle' && w.__condashXterms?.has(id))
          causal.hiddenOwnerAppeared = true;
        let raw = causal.rawPending + data;
        causal.rawPending = raw.endsWith('\r') ? '\r' : '';
        if (causal.rawPending) raw = raw.slice(0, -1);
        let text = causal.pending + raw.replace(/\r\n/g, '\n');
        causal.pending = '';
        if (text.includes('\r')) causal.error = 'unexpected non-newline carriage return';
        if (!causal.inPayload && causal.payloadBytes === 0) {
          const begin = text.indexOf('PAYLOAD-BEGIN\n');
          if (begin < 0) {
            if (text.length > 4096) causal.error = 'causal framing overflow';
            else causal.pending = text;
            text = '';
          } else {
            const preamble = text.slice(0, begin);
            if (preamble.trim()) causal.unexpected.push(preamble);
            text = text.slice(begin + 'PAYLOAD-BEGIN\n'.length);
            causal.inPayload = true;
          }
        }
        if (causal.inPayload && text.length) {
          const from = causal.payloadBytes;
          const take = Math.min(text.length, 3932160 - from);
          const segment = text.slice(0, take);
          if (/[^\x20-\x7e\n]/.test(segment)) causal.error = 'unexpected stdout control bytes';
          causal.chunks.push(segment);
          causal.payloadBytes += take;
          text = text.slice(take);
          const newline = segment.lastIndexOf('\n');
          if (newline >= 0) causal.lastBoundary = from + newline + 1;
          if (take > 0)
            causal.callbacks.push({
              id,
              at: started,
              from,
              to: causal.payloadBytes,
              lastBoundary: causal.lastBoundary,
            });
          receipt.payloadBytes = causal.payloadBytes;
          for (const mark of receipt.marks)
            if (mark.elapsedMs === null && causal.payloadBytes >= mark.bytes)
              mark.elapsedMs = started - receipt.triggerAt;
          if (causal.payloadBytes === 3932160) {
            causal.inPayload = false;
            receipt.receiptAt ??= started;
          }
        }
        if (!causal.inPayload && causal.payloadBytes > 0) {
          causal.trailer += text;
          if (/^PAYLOAD-END 3932160 \d+\nDONE\n$/.test(causal.trailer)) {
            causal.done = true;
            receipt.completionAt ??= started;
          } else if (causal.trailer.includes('DONE\n') || causal.trailer.length > 4096)
            causal.error = 'unexpected causal completion framing';
        }
        causal.launch();
        causal.observerMs += performance.now() - started;
        causal.observerCalls++;
      }
      entry.observerMs += performance.now() - started;
    });
    w.__condashTermTransport = { bySid, dispose: unsubscribe };
  };
  if (w.document.readyState === 'loading') {
    w.document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
};

/**
 * Arm, for THIS document and every later one (the init script survives
 * renderer reloads, like the hydrate-geometry spec's registry arming):
 * the test-only xterm registry attribute, and the transport accumulator
 * subscribed to the app's own `onTermData` delivery stream.
 */
export async function armTerminalTestSurfaces(window: Page): Promise<void> {
  await window.addInitScript(armSurfaces);
  // The init script covers only LATER documents; arm the current one too.
  await window.evaluate(armSurfaces);
}

/** Delivered-byte totals for one session, from the transport accumulator. */
export async function transportStats(
  window: Page,
  sid: string,
): Promise<{ bytes: number; chunks: number; observerMs: number; overflow: boolean }> {
  return window.evaluate((id: string) => {
    const entry = (window as unknown as ProbeWindow).__condashTermTransport?.bySid.get(id);
    return entry
      ? {
          bytes: entry.bytes,
          chunks: entry.chunks,
          observerMs: entry.observerMs,
          overflow: entry.overflow,
        }
      : { bytes: 0, chunks: 0, observerMs: 0, overflow: false };
  }, sid);
}

/** Wait until the accumulator has delivered at least `bytes` for `sid`. */
export async function waitForTransportBytes(
  window: Page,
  sid: string,
  bytes: number,
  timeoutMs = 120_000,
): Promise<{ bytes: number; chunks: number; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stats = await transportStats(window, sid);
    if (stats.bytes >= bytes) return { ...stats, timedOut: false };
    if (stats.overflow) throw new Error(`transport observer overflow: ${sid}`);
    if (Date.now() > deadline)
      throw new Error(`transport byte deadline: ${sid}, ${stats.bytes}/${bytes}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Wait until the accumulator's text for `sid` contains `needle`. */
export async function waitForTransportText(
  window: Page,
  sid: string,
  needle: string,
  timeoutMs = 120_000,
): Promise<{ seenAt: number; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await window.evaluate(
      ({ id, token }) =>
        (window as unknown as ProbeWindow).__condashTermTransport?.bySid
          .get(id)
          ?.text.includes(token) ?? false,
      { id: sid, token: needle },
    );
    if (seen) return { seenAt: Date.now(), timedOut: false };
    if (Date.now() > deadline) throw new Error(`transport text deadline: ${sid}, ${needle}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Count distinct needles among the bytes DELIVERED to the renderer page. */
export async function transportCensus(
  window: Page,
  sid: string,
  needles: string[],
): Promise<{ found: string[]; missing: string[] }> {
  return window.evaluate(
    ({ id, tokens }: { id: string; tokens: string[] }) => {
      const text =
        (window as unknown as ProbeWindow).__condashTermTransport?.bySid.get(id)?.text ?? '';
      const found: string[] = [];
      const missing: string[] = [];
      for (const token of tokens) (text.includes(token) ? found : missing).push(token);
      return { found, missing };
    },
    { id: sid, tokens: needles },
  );
}

/** Full parsed-buffer census from the xterm registry (the acceptance layer). */
export async function registryCensus(
  window: Page,
  sid: string,
  needles: string[],
): Promise<{ found: string[]; missing: string[]; bufferLines: number }> {
  return window.evaluate(
    ({ id, tokens }: { id: string; tokens: string[] }) => {
      const w = window as unknown as ProbeWindow;
      const term = w.__condashXterms?.get(id);
      if (!term) return { found: [], missing: tokens, bufferLines: 0 };
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i++) {
        lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
      }
      const text = lines.join('\n');
      const found: string[] = [];
      const missing: string[] = [];
      for (const token of tokens) (text.includes(token) ? found : missing).push(token);
      return { found, missing, bufferLines: buffer.length };
    },
    { id: sid, tokens: needles },
  );
}

export interface BurstCensusEntry {
  needle: string;
  inTransport: boolean;
  inRegistry: boolean;
  deliveredCount: number;
  deliveredOffset: number;
  rendererCount: number;
  attribution: string;
}

export interface BurstCensusResult {
  entries: BurstCensusEntry[];
  bufferLines: number;
  cols: number;
}

/** Final whole-buffer census; every missing renderer token fails acceptance. */
export async function burstCensus(
  window: Page,
  sid: string,
  needles: string[],
): Promise<BurstCensusResult> {
  return window.evaluate(
    ({ id, tokens }: { id: string; tokens: string[] }) => {
      const w = window as unknown as ProbeWindow;
      const term = w.__condashXterms?.get(id);
      const transportText = w.__condashTermTransport?.bySid.get(id)?.text ?? '';
      const cols = term?.cols ?? 0;
      const bufferLines = term ? term.buffer.active.length : 0;
      let registryText = '';
      if (term) {
        const buffer = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) {
          lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
        }
        registryText = lines.join('\n');
      }
      const entries = tokens.map((needle) => {
        const pos = transportText.indexOf(`PROBE ${needle}`);
        const deliveredCount = transportText.split(`PROBE ${needle}`).length - 1;
        const rendererCount = registryText.split(`PROBE ${needle}`).length - 1;
        return {
          needle,
          inTransport: pos >= 0,
          inRegistry: registryText.includes(needle),
          deliveredOffset: pos,
          deliveredCount,
          rendererCount,
          attribution:
            rendererCount > 0
              ? 'received in final renderer buffer'
              : pos >= 0
                ? 'delivered but absent from final renderer (parse/hydrate/retention discrepancy)'
                : 'upstream-loss attribution unavailable: no independent main-side evidence',
        };
      });
      return { entries, bufferLines, cols };
    },
    { id: sid, tokens: needles },
  );
}

/** Wait until the given session has a live DOM Terminal (it is the active
 *  tab and its mount finished) — the precondition for a first-frame probe,
 *  whose ACK must land in a LIVE viewport, not mid-hydrate where the tab's
 *  flood can scroll it out before the poll's first read. */
export async function waitForDomTerm(window: Page, sid: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const present = await window.evaluate(
      (id: string) => (window as unknown as ProbeWindow).__condashXterms?.has(id) ?? false,
      sid,
    );
    if (present) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for DOM Terminal for ${sid}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * One first-useful-frame sample (buffer level): the whole measurement happens
 * in-page — read the clock, fire `termWrite`, poll the registry on a 4 ms
 * in-page timer, return the elapsed ms. One IPC round-trip per sample; no
 * per-poll transport cost. The signal is the plan's "token visible in the
 * live DOM Terminal's registry BUFFER": the scan covers the last
 * 200 lines (the evaluates inline the literal — Playwright serializes each
 * function alone, so a shared constant cannot be referenced from inside), not
 * just the viewport, because a streaming tab can legitimately scroll a parsed
 * token above the viewport within one poll cycle (a post-hydrate flush drains
 * parked flood at parse speed). The settled marker is recorded
 * opportunistically but is only the SWITCH case's decision statistic.
 */
export async function measureEchoFirstFrame(
  window: Page,
  sid: string,
  token: string,
  timeoutMs = 10_000,
  loadSid?: string,
): Promise<ProbeOutcome> {
  return window.evaluate(
    ({
      id,
      probeToken,
      timeout,
      loadId,
    }: {
      id: string;
      probeToken: string;
      timeout: number;
      loadId?: string;
    }) => {
      const w = window as unknown as ProbeWindow;
      const loadEntry = loadId ? w.__condashTermTransport?.bySid.get(loadId) : undefined;
      const load = loadEntry?.receipt;
      if (loadId && !load) throw new Error('loaded probe has no armed receipt observer');
      const bufferHas = (): boolean => {
        const term = w.__condashXterms?.get(id);
        if (!term) return false;
        const buffer = term.buffer.active;
        const depth = Math.min(buffer.length, Math.max(term.rows, 200));
        for (let i = buffer.length - depth; i < buffer.length; i++) {
          if ((buffer.getLine(i)?.translateToString(true) ?? '').includes('ACK ' + probeToken)) {
            return true;
          }
        }
        return false;
      };
      return new Promise((resolve) => {
        const t0 = performance.now();
        const loadBefore = load
          ? {
              budget: load.budget,
              beforePayloadBytes: load.payloadBytes,
              beforeDeliveredBytes: loadEntry!.bytes,
              beforeDone: load.completionAt !== null,
            }
          : undefined;
        const startedBaseline = w.__condashRepaints?.started ?? 0;
        void w.condash.termWrite(id, probeToken + ' ');
        const readViewport = (): string[] => {
          const term = w.__condashXterms?.get(id);
          if (!term) return ['NO-TERM'];
          const buffer = term.buffer.active;
          const rows: string[] = [];
          for (let y = 0; y < term.rows; y++) {
            rows.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
          }
          return rows;
        };
        const timer = setInterval(() => {
          const elapsed = performance.now() - t0;
          if (bufferHas()) {
            const firstMs = elapsed;
            const loadAtAck =
              load && loadBefore
                ? {
                    ...loadBefore,
                    atAckPayloadBytes: load.payloadBytes,
                    atAckDeliveredBytes: loadEntry!.bytes,
                    atAckDone: load.completionAt !== null,
                  }
                : undefined;
            clearInterval(timer);
            const settledTimer = setInterval(() => {
              const r = w.__condashRepaints;
              const settledDone = r && r.started >= startedBaseline && r.started === r.settled;
              if (settledDone || performance.now() - t0 > timeout) {
                clearInterval(settledTimer);
                resolve({
                  firstMs,
                  settledMs: settledDone ? performance.now() - t0 : -1,
                  timedOut: !settledDone,
                  stage: 'settled',
                  load: loadAtAck,
                });
              }
            }, 4);
            return;
          }
          if (elapsed > timeout) {
            clearInterval(timer);
            resolve({
              firstMs: -1,
              settledMs: -1,
              timedOut: true,
              stage: 'first-frame',
              viewportOnTimeout: readViewport(),
            });
          }
        }, 4);
      });
    },
    { id: sid, probeToken: token, timeout: timeoutMs, loadId: loadSid },
  ) as unknown as ProbeOutcome;
}

/**
 * One settled-switch sample against a hidden (worker-demoted) tab: click the
 * tab in-page, immediately write the probe token, and return BOTH markers —
 * first frame (ACK visible in the live DOM terminal) and settled
 * (`__condashRepaints.settled` catching the baselined `started`, the
 * hydrate-geometry barrier). Grid-vs-pty geometry may only be read after the
 * barrier; the sample returns it for the structural check.
 */
export async function measureSettledSwitch(
  window: Page,
  sid: string,
  token: string,
  timeoutMs = 15_000,
): Promise<ProbeOutcome & { cols: number; rows: number }> {
  return window.evaluate(
    ({ id, probeToken, timeout }: { id: string; probeToken: string; timeout: number }) => {
      const w = window as unknown as ProbeWindow;
      return new Promise((resolve) => {
        const t0 = performance.now();
        const startedBaseline = w.__condashRepaints?.started ?? 0;
        const el = document.querySelector(`[data-sid="${id}"]`) as HTMLElement | null;
        if (!el) {
          resolve({
            firstMs: -1,
            settledMs: -1,
            timedOut: true,
            stage: 'first-frame',
            cols: -1,
            rows: -1,
          });
          return;
        }
        el.click();
        void w.condash.termWrite(id, probeToken + ' ');
        let firstMs = -1;
        const timer = setInterval(() => {
          const term = w.__condashXterms?.get(id);
          const elapsed = performance.now() - t0;
          if (firstMs < 0) {
            if (!term && elapsed > timeout) {
              clearInterval(timer);
              resolve({
                firstMs: -1,
                settledMs: -1,
                timedOut: true,
                stage: 'first-frame',
                cols: -1,
                rows: -1,
              });
              return;
            }
            if (term) {
              // Same buffer-tail scan as the plain first-frame probe: the
              // plan's signal is the registry buffer, and a flood can scroll
              // a parsed token above the viewport within one poll cycle.
              const buffer = term.buffer.active;
              const depth = Math.min(buffer.length, Math.max(term.rows, 200));
              for (let i = buffer.length - depth; i < buffer.length; i++) {
                if (
                  (buffer.getLine(i)?.translateToString(true) ?? '').includes('ACK ' + probeToken)
                ) {
                  firstMs = elapsed;
                  break;
                }
              }
            }
            if (firstMs < 0 && elapsed > timeout) {
              clearInterval(timer);
              resolve({
                firstMs: -1,
                settledMs: -1,
                timedOut: true,
                stage: 'first-frame',
                cols: -1,
                rows: -1,
              });
            }
            return;
          }
          const r = w.__condashRepaints;
          const settledDone = r && r.started > startedBaseline && r.started === r.settled;
          if (settledDone) {
            clearInterval(timer);
            resolve({
              firstMs,
              settledMs: performance.now() - t0,
              timedOut: false,
              stage: 'settled',
              cols: term?.cols ?? -1,
              rows: term?.rows ?? -1,
            });
          } else if (elapsed > timeout) {
            clearInterval(timer);
            resolve({
              firstMs,
              settledMs: -1,
              timedOut: true,
              stage: 'settled',
              cols: -1,
              rows: -1,
            });
          }
        }, 4);
      });
    },
    { id: sid, probeToken: token, timeout: timeoutMs },
  ) as unknown as ProbeOutcome & { cols: number; rows: number };
}

/**
 * Keyboard-dispatch arm (separately labelled, never pooled with the IPC arm):
 * install an in-page poller, then the NODE side drives a real
 * `page.keyboard.type` into the focused terminal, then collect. The measured
 * interval starts at the poller's arm time, so it honestly includes the
 * arm→type gap — reported as such, never pooled.
 */
export async function measureKeyboardEcho(
  window: Page,
  sid: string,
  token: string,
  type: (text: string) => Promise<void>,
  timeoutMs = 10_000,
): Promise<ProbeOutcome> {
  await window.evaluate(
    ({ id, probeToken, timeout }: { id: string; probeToken: string; timeout: number }) => {
      const w = window as unknown as ProbeWindow & {
        __condashKbProbe?: { result: { firstMs: number; timedOut: boolean } | null };
      };
      w.__condashKbProbe = { result: null };
      const t0 = performance.now();
      const timer = setInterval(() => {
        const term = w.__condashXterms?.get(id);
        const elapsed = performance.now() - t0;
        let done = false;
        if (term) {
          const buffer = term.buffer.active;
          const depth = Math.min(buffer.length, Math.max(term.rows, 200));
          for (let i = buffer.length - depth; i < buffer.length; i++) {
            if ((buffer.getLine(i)?.translateToString(true) ?? '').includes('ACK ' + probeToken)) {
              w.__condashKbProbe!.result = { firstMs: elapsed, timedOut: false };
              done = true;
              break;
            }
          }
        }
        if (!done && elapsed > timeout) {
          w.__condashKbProbe!.result = { firstMs: -1, timedOut: true };
          done = true;
        }
        if (done) clearInterval(timer);
      }, 4);
    },
    { id: sid, probeToken: token, timeout: timeoutMs },
  );
  await type(token + ' ');
  const deadline = Date.now() + timeoutMs + 5_000;
  for (;;) {
    const result = await window.evaluate(() => {
      const w = window as unknown as {
        __condashKbProbe?: { result: { firstMs: number; timedOut: boolean } | null };
      };
      const out = w.__condashKbProbe?.result ?? null;
      if (out) w.__condashKbProbe = { result: null };
      return out;
    });
    if (result) {
      return { ...result, settledMs: undefined, stage: 'first-frame' as const };
    }
    if (Date.now() > deadline) {
      return { firstMs: -1, timedOut: true, stage: 'first-frame' };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---- transport floor + registry-read cost (the overhead bounds) ----

export interface FloorMeasurement {
  emptyMedianMs: number;
  registryReadMedianMs: number;
  /** registryReadMedian − emptyMedian: the registry-armed census delta. */
  registryDeltaMs: number;
  samples: number;
}

export async function measureTransportFloor(
  window: Page,
  samples = 200,
): Promise<FloorMeasurement> {
  const empty: number[] = [];
  const registry: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await window.evaluate(() => performance.now());
    empty.push(performance.now() - t0);
    const r0 = performance.now();
    await window.evaluate(() => {
      let characters = 0;
      for (const term of (window as unknown as ProbeWindow).__condashXterms?.values() ?? []) {
        for (let row = 0; row < term.buffer.active.length; row++) {
          characters += term.buffer.active.getLine(row)?.translateToString(true).length ?? 0;
        }
      }
      return characters;
    });
    registry.push(performance.now() - r0);
  }
  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const emptyMedianMs = median(empty);
  const registryReadMedianMs = median(registry);
  return {
    emptyMedianMs,
    registryReadMedianMs,
    registryDeltaMs: registryReadMedianMs - emptyMedianMs,
    samples,
  };
}

// ---- perf counters (batches / pauses / watchdogs) from the throwaway perf dir ----

export interface SessionFlowCounters {
  batches: number;
  pauses: number;
  watchdogs: number;
  inFlightPeak: number;
  bytes: number;
  activityWindows: number;
}

export interface PerfEvidence {
  sinceIso: string;
  untilIso: string;
  covered: boolean;
  gaps: { from: number; until: number }[];
  records: {
    schema: number;
    t: string;
    windowMs: number;
    sessions: Record<string, Record<string, number>>;
  }[];
  rawFiles: Record<string, string>;
  counters: Record<string, SessionFlowCounters>;
}

export function perfCoverage(
  records: PerfEvidence['records'],
  since: number,
  until: number,
): { covered: boolean; gaps: { from: number; until: number }[] } {
  const intervals = records
    .map((record) => ({
      from: Date.parse(record.t) - record.windowMs,
      until: Date.parse(record.t),
    }))
    .sort((left, right) => left.from - right.from);
  let cursor = since;
  const gaps: { from: number; until: number }[] = [];
  for (const interval of intervals) {
    if (interval.until < cursor || interval.from > until) continue;
    if (interval.from > cursor) gaps.push({ from: cursor, until: interval.from });
    cursor = Math.max(cursor, interval.until);
  }
  if (cursor < until) gaps.push({ from: cursor, until });
  return { covered: gaps.length === 0 && intervals.length > 0, gaps };
}

/** Sum per-session flow counters from `.condash/perf/<day>.jsonl` records in
 *  [sinceIso, untilIso]. Test-side read of the app's own opt-in record — the
 *  perf-load.mjs reading discipline. */
export async function readPerfSessionCounters(
  conceptionDir: string,
  sinceIso: string,
  untilIso: string,
  sids: string[],
): Promise<Record<string, SessionFlowCounters>> {
  return (await waitForPerfEvidence(conceptionDir, sinceIso, untilIso, sids)).counters;
}

export async function waitForPerfEvidence(
  conceptionDir: string,
  sinceIso: string,
  untilIso: string,
  sids: string[],
  timeoutMs = 15_000,
): Promise<PerfEvidence> {
  const deadline = Date.now() + timeoutMs;
  const since = Date.parse(sinceIso);
  const until = Date.parse(untilIso);
  for (;;) {
    const rawFiles: Record<string, string> = {};
    const records: PerfEvidence['records'] = [];
    const perfDir = join(conceptionDir, '.condash', 'perf');
    const files = await readdir(perfDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files.filter((file) => file.endsWith('.jsonl')).sort()) {
      const raw = await readFile(join(perfDir, file), 'utf8');
      rawFiles[file] = raw;
      // An append in progress is not a covering record until its newline exists.
      for (const line of raw
        .slice(0, raw.lastIndexOf('\n') + 1)
        .split('\n')
        .filter(Boolean)) {
        const record = JSON.parse(line) as PerfEvidence['records'][number];
        if (
          record.schema !== 4 ||
          !Number.isFinite(Date.parse(record.t)) ||
          !(record.windowMs > 0) ||
          !record.sessions
        )
          throw new Error(`invalid telemetry record in ${file}`);
        records.push(record);
      }
    }
    const coverage = perfCoverage(records, since, until);
    if (coverage.covered) {
      const counters: Record<string, SessionFlowCounters> = {};
      for (const sid of sids)
        counters[sid] = {
          batches: 0,
          pauses: 0,
          watchdogs: 0,
          inFlightPeak: 0,
          bytes: 0,
          activityWindows: 0,
        };
      for (const record of records) {
        if (Date.parse(record.t) < since || Date.parse(record.t) - record.windowMs > until)
          continue;
        for (const sid of sids) {
          const slice = record.sessions[sid];
          if (!slice) continue;
          const counter = counters[sid];
          counter.bytes += slice.bytes ?? 0;
          counter.batches += slice.batches ?? 0;
          counter.pauses += slice.pauses ?? 0;
          counter.watchdogs += slice.watchdogs ?? 0;
          counter.inFlightPeak = Math.max(counter.inFlightPeak, slice.inFlightPeak ?? 0);
          counter.activityWindows++;
        }
      }
      return { sinceIso, untilIso, ...coverage, records, rawFiles, counters };
    }
    if (Date.now() > deadline)
      throw new Error(
        `telemetry does not cover ${sinceIso}..${untilIso}: ${JSON.stringify(coverage.gaps)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---- per-run identity record ----

export interface RunIdentity {
  recordedAt: string;
  label: string;
  gitSha: string;
  gitDirty: boolean;
  mainBundleSha256: string;
  preloadBundleSha256: string;
  rendererIndexSha256: string;
  rendererAssets: { name: string; sha256: string }[];
  nodeVersion: string;
  electronVersion: string;
  platform: string;
  cpuModel: string;
  cpuCount: number;
  loadavg1m: number;
  ciFlag: string | null;
  cpuAffinity: string | null;
  rendererAffinity: string;
  baseSha: string;
  sourceHashes: { name: string; sha256: string }[];
  fixtureHashes: { name: string; sha256: string }[];
  harnessHashes: { name: string; sha256: string }[];
  lockfileSha256: string;
  loadedRendererUrl: string;
  embeddedNodeVersion: string;
  xvfbVersion: string;
}

function sha256File(path: string): Promise<string> {
  return readFile(path).then((buf) => createHash('sha256').update(buf).digest('hex'));
}

async function gitInfo(repoRoot: string): Promise<{ sha: string; dirty: boolean }> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot });
  return { sha: stdout.trim(), dirty: status.stdout.trim().length > 0 };
}

export async function recordIdentity(
  app: ElectronApplication,
  repoRoot: string,
  label: string,
): Promise<RunIdentity> {
  const os = await import('node:os');
  const { sha, dirty } = await gitInfo(repoRoot);
  const runtime = await app.evaluate(({ BrowserWindow }) => ({
    electron: process.versions.electron ?? 'unknown',
    node: process.version,
    pid: process.pid,
    rendererPid: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
    rendererUrl: BrowserWindow.getAllWindows()[0].webContents.getURL(),
  }));
  const affinity = async (pid: number): Promise<string> =>
    (await readFile(`/proc/${pid}/status`, 'utf8')).match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ??
    'unavailable';
  const baseSha = (
    await execFileAsync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: repoRoot })
  ).stdout.trim();
  const hashTree = async (root: string): Promise<{ name: string; sha256: string }[]> => {
    const entries: { name: string; sha256: string }[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile())
          entries.push({ name: path.slice(repoRoot.length + 1), sha256: await sha256File(path) });
      }
    };
    await walk(root);
    return entries;
  };
  const xvfb = await execFileAsync('dpkg-query', ['-W', '-f=${Version}', 'xvfb']);
  const cpus = os.cpus();
  return {
    recordedAt: new Date().toISOString(),
    label,
    gitSha: sha,
    gitDirty: dirty,
    mainBundleSha256: await sha256File(join(repoRoot, 'dist-electron', 'main', 'index.js')),
    preloadBundleSha256: await sha256File(join(repoRoot, 'dist-electron', 'preload', 'index.js')),
    rendererIndexSha256: await sha256File(join(repoRoot, 'dist', 'index.html')),
    rendererAssets: await hashTree(join(repoRoot, 'dist', 'assets')),
    nodeVersion: process.version,
    electronVersion: runtime.electron,
    platform: `${os.platform()} ${os.release()}`,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    loadavg1m: os.loadavg()[0],
    ciFlag: process.env.CI ?? null,
    cpuAffinity: await affinity(runtime.pid),
    rendererAffinity: await affinity(runtime.rendererPid),
    baseSha,
    sourceHashes: await hashTree(join(repoRoot, 'src')),
    fixtureHashes: await Promise.all(
      [
        'echo-probe-tui.mjs',
        'sustained-output-fixture.mjs',
        'terminal-acceptance.ts',
        'acceptance-stats.ts',
        'terminal-causal-trace.ts',
      ].map(async (name) => ({
        name,
        sha256: await sha256File(join(repoRoot, 'tests', 'fixtures', name)),
      })),
    ),
    embeddedNodeVersion: runtime.node,
    harnessHashes: await Promise.all(
      [
        'terminal-acceptance.spec.ts',
        'terminal-acceptance-measure.spec.ts',
        'terminal-acceptance-kit.test.ts',
        'terminal-causal-trace.test.ts',
      ].map(async (name) => ({ name, sha256: await sha256File(join(repoRoot, 'tests', name)) })),
    ),
    lockfileSha256: await sha256File(join(repoRoot, 'package-lock.json')),
    loadedRendererUrl: runtime.rendererUrl,
    xvfbVersion: `installed xvfb package ${xvfb.stdout.trim()}`,
  };
}

// ---- threshold evaluation against the user-approved table (2026-10-07) ----

export interface ThresholdCheck {
  probe: string;
  summary: SampleSummary;
  medianBound?: number;
  p95Bound?: number;
  structuralOnly?: boolean;
  pass: boolean;
  detail: string;
}

export function checkThreshold(
  probe: string,
  summary: SampleSummary,
  bounds: { medianBound?: number; p95Bound?: number; structuralOnly?: boolean },
): ThresholdCheck {
  const checks: string[] = [];
  let pass = true;
  if (bounds.structuralOnly) {
    checks.push('structural-only (no numeric threshold)');
  } else {
    if (bounds.medianBound !== undefined) {
      const ok = summary.median <= bounds.medianBound;
      pass = pass && ok;
      checks.push(
        `median ${summary.median.toFixed(1)} ≤ ${bounds.medianBound} ms: ${ok ? 'PASS' : 'FAIL'}`,
      );
    }
    if (bounds.p95Bound !== undefined) {
      const ok = summary.p95 <= bounds.p95Bound;
      pass = pass && ok;
      checks.push(
        `p95 ${summary.p95.toFixed(1)} ≤ ${bounds.p95Bound} ms (descriptive): ${ok ? 'PASS' : 'FAIL'}`,
      );
    }
  }
  return { probe, summary, ...bounds, pass, detail: checks.join('; ') };
}

/** Local calculations never become an acceptance pass without verified CI eligibility. */
export function classifyAcceptanceReport(input: {
  ciFlag: string | null;
  cpuAffinity: string | null;
  rendererAffinity: string;
  structuralFailures: number;
  validityFailures: number;
  thresholdChecksPass: boolean;
  purpose?: 'acceptance' | 'qualification-smoke';
}): {
  thresholdJudgmentEligible: boolean;
  allDescriptiveChecksClear: boolean;
  allPass: boolean;
  state:
    | 'complete-descriptive-clear'
    | 'complete-descriptive-failed-checks'
    | 'complete-acceptance-pass'
    | 'complete-acceptance-failed-gates'
    | 'complete-qualification-smoke-clear'
    | 'complete-qualification-smoke-failed-checks';
} {
  const thresholdJudgmentEligible =
    input.ciFlag === '1' && input.cpuAffinity === '0-1' && input.rendererAffinity === '0-1';
  const allDescriptiveChecksClear =
    input.structuralFailures === 0 && input.validityFailures === 0 && input.thresholdChecksPass;
  const smoke = input.purpose === 'qualification-smoke';
  const allPass = !smoke && thresholdJudgmentEligible && allDescriptiveChecksClear;
  const state = smoke
    ? allDescriptiveChecksClear
      ? 'complete-qualification-smoke-clear'
      : 'complete-qualification-smoke-failed-checks'
    : thresholdJudgmentEligible
      ? allPass
        ? 'complete-acceptance-pass'
        : 'complete-acceptance-failed-gates'
      : allDescriptiveChecksClear
        ? 'complete-descriptive-clear'
        : 'complete-descriptive-failed-checks';
  return { thresholdJudgmentEligible, allDescriptiveChecksClear, allPass, state };
}

export { summarize };

export async function disposeTerminalTestSurfaces(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as ProbeWindow & { __acceptanceHeartbeat?: number };
    for (const entry of state.__condashTermTransport?.bySid.values() ?? [])
      for (const timer of entry.causal?.timers ?? []) clearInterval(timer);
    state.__condashTermTransport?.dispose();
    delete state.__condashTermTransport;
    if (state.__acceptanceHeartbeat) clearInterval(state.__acceptanceHeartbeat);
  });
}

export async function causalPayloadPlan(fixturePath: string): Promise<TraceExpected['writeEnds']> {
  const source = await readFile(fixturePath, 'utf8');
  const boundary = source.indexOf('// ---- stdin echo');
  if (boundary < 0) throw new Error('fixture plan boundary missing');
  const lines: string[] = runInNewContext(source.slice(0, boundary) + '\nlines;', {
    process: {
      argv: ['node', 'fixture', '--mode', 'burst', '--seed', '271828'],
      stdout: {
        write() {
          throw new Error('invalid pinned fixture plan');
        },
      },
      exit() {
        throw new Error('invalid pinned fixture plan');
      },
    },
  });
  const payload = lines.join('\n') + '\n';
  if (
    payload.length !== PAYLOAD_BYTES ||
    createHash('sha256').update(payload).digest('hex') !== PAYLOAD_SHA256
  )
    throw new Error('pinned fixture plan identity changed');
  let bytes = 0;
  return lines.map((line) => (bytes += line.length + 1));
}

/** Arm the complete callback history and count scheduler before GO. No transport round-trip chooses an ACK phase. */
export async function startCausalPayload(
  page: Page,
  sid: string,
  arm: TraceExpected['arm'],
  echoSid?: string,
): Promise<void> {
  await page.evaluate(
    ({ source, arm, echo }) => {
      const state = window as unknown as ProbeWindow;
      const entry = state.__condashTermTransport?.bySid.get(source);
      if (!entry || entry.causal || (arm === 'hidden-burst-idle' && (!echo || echo === source)))
        throw new Error('invalid causal stream preparation');
      const owner = state.__condashXterms?.get(source);
      if ((arm === 'active-census') !== !!owner)
        throw new Error('causal source owner/arm mismatch before GO');
      const causal: CausalPayloadWatch = {
        source,
        echo: echo ?? null,
        arm,
        payloadBytes: 0,
        chunks: [],
        pending: '',
        rawPending: '',
        inPayload: false,
        trailer: '',
        done: false,
        error: null,
        callbacks: [],
        attempts:
          arm === 'hidden-burst-idle'
            ? Array.from({ length: 30 }, (_, index) => ({
                index: index + 1,
                target: Math.floor((3932160 * (index + 1)) / 31),
                status: 'unattempted',
              }))
            : [],
        unexpected: [],
        lastBoundary: 0,
        observerMs: 0,
        observerCalls: 0,
        ackPollMs: 0,
        ackPollCalls: 0,
        owner,
        ownerLost: false,
        hiddenOwnerAppeared: false,
        next: 0,
        pendingAttempt: null,
        timers: [],
        launch: () => undefined,
      };
      entry.causal = causal;
      entry.receipt = {
        budget: 3932160,
        triggerAt: performance.now(),
        pending: '',
        inPayload: false,
        payloadBytes: 0,
        receiptAt: null,
        completionAt: null,
        marks: [{ bytes: 3932160, elapsedMs: null }],
      };
      causal.launch = () => {
        if (causal.error || causal.pendingAttempt || causal.next >= causal.attempts.length) return;
        const attempt = causal.attempts[causal.next];
        if (causal.payloadBytes < attempt.target && !causal.done) return;
        if (causal.done || causal.payloadBytes >= 3932160) {
          for (let index = causal.next; index < 30; index++)
            causal.attempts[index].status = 'unattemptable-completed';
          causal.next = 30;
          return;
        }
        causal.next++;
        attempt.before = { ...causal.callbacks.at(-1)! };
        attempt.token = `P${String(attempt.index).padStart(4, '0')}`;
        attempt.triggerAt = performance.now();
        attempt.startedBaseline = state.__condashRepaints?.started ?? 0;
        attempt.status = 'pending';
        causal.pendingAttempt = attempt;
        void state.condash.termWrite(echo!, attempt.token + ' ').catch((error) => {
          causal.error = 'echo trigger failed: ' + String(error);
        });
        const timer = setInterval(() => {
          const pollAt = performance.now();
          const term = state.__condashXterms?.get(echo!);
          let found = false;
          if (term)
            for (
              let row = Math.max(0, term.buffer.active.length - Math.max(term.rows, 200));
              row < term.buffer.active.length;
              row++
            )
              if (
                term.buffer.active
                  .getLine(row)
                  ?.translateToString(true)
                  .includes('ACK ' + attempt.token)
              )
                found = true;
          causal.ackPollMs += performance.now() - pollAt;
          causal.ackPollCalls++;
          if (found) {
            attempt.ackAt = pollAt;
            attempt.firstMs = pollAt - attempt.triggerAt!;
            attempt.atAckBytes = causal.payloadBytes;
            attempt.status = 'acked';
            attempt.checkpointSentAt = performance.now();
            void state.condash.termWrite(source, `C${attempt.index} `).catch((error) => {
              causal.error = 'checkpoint send failed: ' + String(error);
            });
            clearInterval(timer);
            const settlement = setInterval(() => {
              const counters = state.__condashRepaints;
              const settled =
                counters &&
                counters.started >= attempt.startedBaseline! &&
                counters.started === counters.settled;
              if (settled || performance.now() - attempt.triggerAt! > 10000) {
                attempt.settlementValid = !!settled;
                attempt.settledMs = settled ? performance.now() - attempt.triggerAt! : -1;
                clearInterval(settlement);
                causal.pendingAttempt = null;
                causal.launch();
              }
            }, 4);
            causal.timers.push(settlement);
          } else if (pollAt - attempt.triggerAt! > 10000) {
            attempt.status = 'timeout';
            clearInterval(timer);
            causal.pendingAttempt = null;
            causal.launch();
          }
        }, 4);
        causal.timers.push(timer);
      };
      void state.condash.termWrite(source, 'GO ').catch((error) => {
        causal.error = 'source GO failed: ' + String(error);
      });
    },
    { source: sid, arm, echo: echoSid },
  );
}

export async function causalObservations(page: Page, sid: string) {
  return page.evaluate((id) => {
    const state = window as unknown as ProbeWindow;
    const watch = state.__condashTermTransport?.bySid.get(id)?.causal;
    if (!watch) throw new Error('missing causal observation stream');
    return {
      payload: watch.chunks.join(''),
      callbacks: watch.callbacks,
      attempts: watch.attempts,
      unexpected: watch.unexpected,
      trailer: watch.trailer,
      done: watch.done,
      error: watch.error,
      ownerLost: watch.ownerLost,
      samePreparedOwner: watch.owner === state.__condashXterms?.get(id),
      hiddenOwnerAppeared: watch.hiddenOwnerAppeared,
      pendingAttempt: watch.pendingAttempt !== null,
      observerMs: watch.observerMs,
      observerCalls: watch.observerCalls,
      ackPollMs: watch.ackPollMs,
      ackPollCalls: watch.ackPollCalls,
    };
  }, sid);
}

export async function waitForCausalSource(
  page: Page,
  sid: string,
  expected: TraceExpected,
  timeoutMs = 90000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await page.evaluate((id) => {
      const watch = (window as unknown as ProbeWindow).__condashTermTransport?.bySid.get(
        id,
      )?.causal;
      return { error: watch?.error, ready: watch?.done && !watch.pendingAttempt };
    }, sid);
    if (state.error) throw new Error(state.error);
    try {
      await lstat(expected.sealPath);
      if (state.ready) return await readSealedTrace(expected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (Date.now() > deadline)
      throw new Error('complete causal export/observation deadline: ' + sid);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function requireTraceFilesAbsent(expected: TraceExpected): Promise<void> {
  for (const path of [expected.sealPath, expected.eventsFile]) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('trace unexpectedly exists before GO: ' + path);
  }
}

export async function startTelemetryHeartbeat(page: Page, conceptionDir: string): Promise<string> {
  const enabled = await page.evaluate(() => window.condash.perfSetEnabled(true));
  if (!enabled.recording || enabled.writeFailed) throw new Error('telemetry recorder unavailable');
  await page.evaluate(() => {
    const state = window as unknown as { __acceptanceHeartbeat?: number };
    // Keep every measured recorder window observable, including otherwise-idle gaps.
    state.__acceptanceHeartbeat = window.setInterval(() => void window.condash.perfVitals(), 250);
  });
  const deadline = Date.now() + 15_000;
  const directory = join(conceptionDir, '.condash', 'perf');
  for (;;) {
    const files = await readdir(directory).catch(() => [] as string[]);
    for (const file of files.filter((file) => file.endsWith('.jsonl'))) {
      const text = await readFile(join(directory, file), 'utf8');
      const lines = text
        .slice(0, text.lastIndexOf('\n') + 1)
        .split('\n')
        .filter(Boolean);
      if (lines.length > 0) {
        const record = JSON.parse(lines.at(-1)!);
        if (record.schema === 4 && record.windowMs > 0) return new Date().toISOString();
      }
    }
    if (Date.now() > deadline) throw new Error('no initial observable telemetry window');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function deliveredPayload(
  page: Page,
  sid: string,
): Promise<{
  payloadBytes: number;
  payloadLines: number;
  done: boolean;
  scheduledBytes: number;
  elapsedMs: number;
  lineLengths: Record<string, number>;
  timing: {
    fullReceiptMs: number | null;
    completionMs: number | null;
    observedPayloadBytes: number;
    marks: { bytes: number; elapsedMs: number | null }[];
  } | null;
}> {
  return page.evaluate((id) => {
    const entry = (window as unknown as ProbeWindow).__condashTermTransport?.bySid.get(id);
    if (entry?.overflow) throw new Error('transport observer overflow');
    const text = (entry?.text ?? '').replace(/\r\n/g, '\n');
    const start = text.indexOf('PAYLOAD-BEGIN\n');
    const tail = start < 0 ? '' : text.slice(start + 'PAYLOAD-BEGIN\n'.length);
    const end = tail.indexOf('PAYLOAD-END ');
    const payload = (end < 0 ? tail : tail.slice(0, end)).replace(/^ACK P\d+[^\n]*\n/gm, '');
    const done = tail.match(/PAYLOAD-END (\d+) (\d+)\n/);
    const lineLengths: Record<string, number> = {};
    const lines = payload.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) lineLengths[line.length] = (lineLengths[line.length] ?? 0) + 1;
    return {
      payloadBytes: entry?.receipt?.payloadBytes ?? payload.length,
      payloadLines: lines.length,
      done: done !== null,
      scheduledBytes: done ? Number(done[1]) : -1,
      elapsedMs: done ? Number(done[2]) : -1,
      lineLengths,
      timing: entry?.receipt
        ? {
            fullReceiptMs:
              entry.receipt.receiptAt === null
                ? null
                : entry.receipt.receiptAt - entry.receipt.triggerAt,
            completionMs:
              entry.receipt.completionAt === null
                ? null
                : entry.receipt.completionAt - entry.receipt.triggerAt,
            observedPayloadBytes: entry.receipt.payloadBytes,
            marks: entry.receipt.marks,
          }
        : null,
    };
  }, sid);
}

/** Arm callback-time receipt markers before triggering this finite fixture. */
export async function startPayload(
  page: Page,
  sid: string,
  budget: number,
  step = budget,
): Promise<void> {
  await page.evaluate(
    async ({ id, budget, step }) => {
      const state = window as unknown as ProbeWindow;
      const observer = state.__condashTermTransport;
      if (!observer) throw new Error('receipt observer is not armed');
      let entry = observer.bySid.get(id);
      if (!entry) {
        entry = { bytes: 0, chunks: 0, text: '', observerMs: 0, overflow: false };
        observer.bySid.set(id, entry);
      }
      entry.receipt = {
        budget,
        triggerAt: performance.now(),
        pending: '',
        inPayload: false,
        payloadBytes: 0,
        receiptAt: null,
        completionAt: null,
        marks: Array.from({ length: Math.ceil(budget / step) }, (_, index) => ({
          bytes: Math.min(budget, (index + 1) * step),
          elapsedMs: null,
        })),
      };
      await state.condash.termWrite(id, 'GO');
    },
    { id: sid, budget, step },
  );
}

/** Prepared retention belongs only to this test instance, not product preferences. */
export async function prepareBurstRetention(
  page: Page,
  sid: string,
  scrollback: number,
): Promise<{
  before: Awaited<ReturnType<typeof settledGeometry>>;
  prepared: Awaited<ReturnType<typeof settledGeometry>>;
}> {
  const before = await settledGeometry(page, sid);
  await page.evaluate(
    ({ id, scrollback }) => {
      const term = (window as unknown as ProbeWindow).__condashXterms?.get(id);
      if (!term) throw new Error('missing mounted census fixture');
      term.options.scrollback = scrollback;
    },
    { id: sid, scrollback },
  );
  const prepared = await settledGeometry(page, sid);
  if (
    prepared.scrollback !== scrollback ||
    prepared.cols !== before.cols ||
    prepared.rows !== before.rows ||
    prepared.pty.cols !== before.pty.cols ||
    prepared.pty.rows !== before.pty.rows
  )
    throw new Error('fixture preparation changed geometry or failed retention');
  return { before, prepared };
}

export function isLoadedAck(outcome: ProbeOutcome): boolean {
  const load = outcome.load;
  return (
    !!load &&
    !load.beforeDone &&
    !load.atAckDone &&
    load.beforePayloadBytes < load.budget &&
    load.atAckPayloadBytes < load.budget &&
    load.atAckDeliveredBytes > load.beforeDeliveredBytes
  );
}

export async function waitForPayload(
  page: Page,
  sid: string,
  bytes: number,
  complete = false,
  timeoutMs = 120_000,
): Promise<Awaited<ReturnType<typeof deliveredPayload>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const payload = await deliveredPayload(page, sid);
    if (payload.payloadBytes >= bytes && (!complete || payload.done)) return payload;
    if (Date.now() >= deadline)
      throw new Error(`payload incomplete: ${sid}, ${JSON.stringify(payload)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function requiredWrappedRows(lineLengths: Record<string, number>, cols: number): number {
  if (!Number.isInteger(cols) || cols <= 0) throw new Error('invalid fitted columns');
  return Object.entries(lineLengths).reduce(
    (sum, [length, count]) => sum + Math.max(1, Math.ceil(Number(length) / cols)) * count,
    0,
  );
}

export async function settledGeometry(
  page: Page,
  sid: string,
): Promise<{
  rows: number;
  cols: number;
  scrollback: number;
  bufferLines: number;
  pty: { rows: number; cols: number };
}> {
  return page.evaluate(async (id) => {
    const state = window as unknown as ProbeWindow;
    const deadline = performance.now() + 15_000;
    for (;;) {
      const counters = state.__condashRepaints;
      const term = state.__condashXterms?.get(id);
      if (counters && counters.started === counters.settled && term) {
        const baseline = counters.started;
        const pty = await state.condash.termGeometry(id);
        if (
          pty &&
          state.__condashRepaints?.started === baseline &&
          state.__condashRepaints.settled === baseline
        ) {
          if (pty.rows !== term.rows || pty.cols !== term.cols)
            throw new Error(
              `settled grid/PTY mismatch: ${JSON.stringify({ rows: term.rows, cols: term.cols, pty })}`,
            );
          return {
            rows: term.rows,
            cols: term.cols,
            scrollback: term.options.scrollback ?? -1,
            bufferLines: term.buffer.active.length,
            pty,
          };
        }
      }
      if (performance.now() > deadline) throw new Error('geometry settlement deadline');
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
  }, sid);
}

export async function measureHiddenBandReturn(
  page: Page,
  sid: string,
  token: string,
): Promise<ProbeOutcome & { identityPreserved: boolean }> {
  await page.evaluate((id) => {
    const state = window as unknown as ProbeWindow & { __acceptanceMask?: Map<string, unknown> };
    if (!state.__condashXterms?.get(id)) throw new Error('missing active term before mask');
    state.__acceptanceMask = new Map(state.__condashXterms);
  }, sid);
  await page.locator('.rail').getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.waitForFunction((id) => {
    const state = window as unknown as ProbeWindow & { __acceptanceMask?: Map<string, unknown> };
    const term = state.__condashXterms?.get(id);
    const same =
      state.__acceptanceMask?.size === state.__condashXterms?.size &&
      [...(state.__acceptanceMask ?? [])].every(
        ([key, value]) => state.__condashXterms?.get(key) === value,
      );
    if (!same) throw new Error('masked mounted identity changed');
    return term?.element?.getClientRects().length === 0;
  }, sid);
  await page.evaluate(({ id, token }) => window.condash.termWrite(id, token + ' '), {
    id: sid,
    token,
  });
  await waitForTransportText(page, sid, 'ACK ' + token);
  return page.evaluate(
    ({ id, token }) => {
      const state = window as unknown as ProbeWindow & { __acceptanceMask?: Map<string, unknown> };
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.rail button')).find(
        (button) => button.textContent?.trim() === 'Terminal',
      );
      if (!button) throw new Error('Terminal rail action missing');
      const started = performance.now();
      const baseline = state.__condashRepaints?.started ?? 0;
      button.click();
      return new Promise<ProbeOutcome & { identityPreserved: boolean }>((resolve, reject) => {
        let firstMs = -1;
        const timer = setInterval(() => {
          const term = state.__condashXterms?.get(id);
          const same =
            state.__acceptanceMask?.size === state.__condashXterms?.size &&
            [...(state.__acceptanceMask ?? [])].every(
              ([key, value]) => state.__condashXterms?.get(key) === value,
            );
          if (!same) {
            clearInterval(timer);
            reject(new Error('returned mounted identity changed'));
            return;
          }
          if (firstMs < 0 && term?.element?.getClientRects().length) {
            for (let row = 0; row < term.buffer.active.length; row++) {
              if (
                term.buffer.active
                  .getLine(row)
                  ?.translateToString(true)
                  .includes('ACK ' + token)
              ) {
                firstMs = performance.now() - started;
                break;
              }
            }
          }
          const repaint = state.__condashRepaints;
          if (
            firstMs >= 0 &&
            repaint &&
            repaint.started >= baseline &&
            repaint.started === repaint.settled
          ) {
            clearInterval(timer);
            resolve({
              firstMs,
              settledMs: performance.now() - started,
              timedOut: false,
              stage: 'settled',
              identityPreserved: same,
            });
          } else if (performance.now() - started > 15_000) {
            clearInterval(timer);
            reject(new Error('hidden return deadline'));
          }
        }, 4);
      });
    },
    { id: sid, token },
  );
}

export async function measureObserverOverhead(
  page: Page,
  sid: string,
  tokens: string[],
  samples = 30,
): Promise<{
  censusOnlyMs: number[];
  registryArmedMs: number[];
  pairedDeltaMs: number[];
  deliveredObserver: Awaited<ReturnType<typeof transportStats>>;
}> {
  const comparison = await page.evaluate(
    async ({ id, tokens, samples }) => {
      const state = window as unknown as ProbeWindow;
      const term = state.__condashXterms?.get(id);
      const text = state.__condashTermTransport?.bySid.get(id)?.text ?? '';
      if (!term || !text) throw new Error('overhead comparison needs an observed mounted session');
      const censusOnlyMs: number[] = [];
      const registryArmedMs: number[] = [];
      const census = () => tokens.filter((token) => text.includes(token)).length;
      const registry = () => {
        const lines: string[] = [];
        for (let row = 0; row < term.buffer.active.length; row++)
          lines.push(term.buffer.active.getLine(row)?.translateToString(true) ?? '');
        const parsed = lines.join('\n');
        return census() + tokens.filter((token) => parsed.includes(token)).length;
      };
      for (let index = 0; index < samples; index++) {
        const run = (body: () => number) => {
          const start = performance.now();
          body();
          return performance.now() - start;
        };
        if (index % 2 === 0) {
          censusOnlyMs.push(run(census));
          registryArmedMs.push(run(registry));
        } else {
          registryArmedMs.push(run(registry));
          censusOnlyMs.push(run(census));
        }
        // Yield between measured pairs so the observer/telemetry timers stay live.
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      return {
        censusOnlyMs,
        registryArmedMs,
        pairedDeltaMs: registryArmedMs.map((time, index) => time - censusOnlyMs[index]),
      };
    },
    { id: sid, tokens, samples },
  );
  return { ...comparison, deliveredObserver: await transportStats(page, sid) };
}
