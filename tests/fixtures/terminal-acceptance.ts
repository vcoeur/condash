import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { summarize, type SampleSummary } from './acceptance-stats';

/**
 * Measurement kit for the terminal-acceptance harness (plan probe families
 * 1-6). Everything here is TEST-SIDE: the only application surfaces touched
 * are the product-exposed ones the parent evidence already identified — the
 * opt-in xterm buffer registry (`data-test-xterm-registry` →
 * `__condashXterms`), the settled-repaint counters (`__condashRepaints`),
 * `termWrite` / `termAttach`, and the renderer-facing `onTermData`
 * subscription. No `src/` change, no production instrumentation.
 *
 * The transport accumulator deserves its own note. The plan's attribution
 * layer sampled the main-side 64 KB tail via `termAttach` at token cadence,
 * but `termAttach` runs `flow.reset()` on every call
 * (src/main/terminals.ts), and mid-burst that DROPS the pending renderer
 * batch — a harness-caused renderer-layer loss that the census would
 * mis-attribute exactly as review finding F1 warned. This kit instead
 * subscribes, in-page, to the app's own delivered-byte stream
 * (`window.condash.onTermData` — the same preload seam the terminal pane and
 * code-run rows use; the flow-control ack rides a separate dedicated preload
 * listener, so observing costs nothing and perturbs nothing). That layer
 * covers the whole run by construction — strictly stronger than sampled 64 KB
 * windows — and the plan's single end-of-run `termAttach` tail read (safe
 * once output has stopped) is still taken as a third, main-side slice.
 * `bytesSeen` itself is main-process-only (not in the `TermSession` payload),
 * so the sustained-receipt wait also rides the accumulator's delivered-byte
 * count — the end of the app's own delivery path — rather than an
 * unimplemented `termList` field.
 */

const execFileAsync = promisify(execFile);

const POLL_MS = 4; // the plan's stated in-page quantization

/** The app surfaces this kit waits on, plus the test-only accumulator. */
interface ProbeWindow {
  __condashXterms?: Map<
    string,
    {
      rows: number;
      cols: number;
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
    bySid: Map<string, { bytes: number; chunks: number; text: string }>;
  };
  condash: {
    termWrite(id: string, data: string): Promise<void>;
    termAttach(id: string): Promise<{ output: string; exited?: number } | null>;
    onTermData(cb: (msg: { id: string; data: string }) => void): void;
  };
}

export interface ProbeOutcome {
  firstMs: number;
  settledMs?: number;
  timedOut: boolean;
  stage: 'first-frame' | 'settled';
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
    const bySid = new Map<string, { bytes: number; chunks: number; text: string }>();
    w.__condashTermTransport = { bySid };
    w.condash.onTermData(({ id, data }) => {
      let entry = bySid.get(id);
      if (!entry) {
        entry = { bytes: 0, chunks: 0, text: '' };
        bySid.set(id, entry);
      }
      entry.bytes += data.length;
      entry.chunks += 1;
      // The burst is ~3.9 MB; a soft cap keeps a runaway fixture from growing
      // the page without bound while never truncating a planned census.
      if (entry.text.length < 32_000_000) entry.text += data;
    });
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
): Promise<{ bytes: number; chunks: number }> {
  return window.evaluate((id: string) => {
    const entry = (window as unknown as ProbeWindow).__condashTermTransport?.bySid.get(id);
    return entry ? { bytes: entry.bytes, chunks: entry.chunks } : { bytes: 0, chunks: 0 };
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
    if (Date.now() > deadline) return { ...stats, timedOut: true };
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
    if (Date.now() > deadline) return { seenAt: -1, timedOut: true };
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

/**
 * The plan's single end-of-run MAIN-side tail read (`termAttach`), taken only
 * AFTER output has stopped — mid-burst it would reset flow control and drop
 * the pending renderer batch (see the module header). Scope: the last
 * MAX_BUFFER = 64,000 chars, i.e. the final ~0.49 s of a burst.
 */
export async function mainTailCensus(
  window: Page,
  sid: string,
  needles: string[],
): Promise<{ found: string[]; missing: string[]; tailChars: number }> {
  return window.evaluate(
    async ({ id, tokens }: { id: string; tokens: string[] }) => {
      const attached = await (window as unknown as ProbeWindow).condash.termAttach(id);
      const text = attached?.output ?? '';
      const found: string[] = [];
      const missing: string[] = [];
      for (const token of tokens) (text.includes(token) ? found : missing).push(token);
      return { found, missing, tailChars: text.length };
    },
    { id: sid, tokens: needles },
  );
}

/**
 * One first-useful-frame sample (buffer level): the whole measurement happens
 * in-page — read the clock, fire `termWrite`, poll the registry viewport on a
 * 4 ms in-page timer, return the elapsed ms. One IPC round-trip per sample;
 * no per-poll transport cost. The settled marker is recorded opportunistically
 * but is only the SWITCH case's decision statistic.
 */
export async function measureEchoFirstFrame(
  window: Page,
  sid: string,
  token: string,
  timeoutMs = 10_000,
): Promise<ProbeOutcome> {
  return window.evaluate(
    ({ id, probeToken, timeout }: { id: string; probeToken: string; timeout: number }) => {
      const w = window as unknown as ProbeWindow;
      const viewportHas = (): boolean => {
        const term = w.__condashXterms?.get(id);
        if (!term) return false;
        const buffer = term.buffer.active;
        for (let y = 0; y < term.rows; y++) {
          if (
            (buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').includes(
              'ACK ' + probeToken,
            )
          ) {
            return true;
          }
        }
        return false;
      };
      return new Promise((resolve) => {
        const t0 = performance.now();
        const startedBaseline = w.__condashRepaints?.started ?? 0;
        void w.condash.termWrite(id, probeToken);
        const timer = setInterval(() => {
          const elapsed = performance.now() - t0;
          if (viewportHas()) {
            const firstMs = elapsed;
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
                });
              }
            }, 4);
            return;
          }
          if (elapsed > timeout) {
            clearInterval(timer);
            resolve({ firstMs: -1, settledMs: -1, timedOut: true, stage: 'first-frame' });
          }
        }, 4);
      });
    },
    { id: sid, probeToken: token, timeout: timeoutMs },
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
        void w.condash.termWrite(id, probeToken);
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
              const buffer = term.buffer.active;
              for (let y = 0; y < term.rows; y++) {
                if (
                  (buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').includes(
                    'ACK ' + probeToken,
                  )
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
          const settledDone = r && r.started >= startedBaseline && r.started === r.settled;
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
          for (let y = 0; y < term.rows; y++) {
            if (
              (buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').includes(
                'ACK ' + probeToken,
              )
            ) {
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
  await type(token);
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
    await window.evaluate(
      () => (window as unknown as ProbeWindow).__condashRepaints?.started ?? -1,
    );
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
  const out: Record<string, SessionFlowCounters> = {};
  for (const sid of sids) out[sid] = { batches: 0, pauses: 0, watchdogs: 0, inFlightPeak: 0 };
  const perfDir = join(conceptionDir, '.condash', 'perf');
  let files: string[] = [];
  try {
    files = (await readdir(perfDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return out; // recording never wrote anything — counters stay zero
  }
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(join(perfDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record: { t?: string; sessions?: Record<string, Record<string, number>> };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record.t || record.t < sinceIso || record.t > untilIso || !record.sessions) continue;
      for (const sid of sids) {
        const slice = record.sessions[sid];
        if (!slice) continue;
        out[sid].batches += slice.batches ?? 0;
        out[sid].pauses += slice.pauses ?? 0;
        out[sid].watchdogs += slice.watchdogs ?? 0;
        out[sid].inFlightPeak = Math.max(out[sid].inFlightPeak, slice.inFlightPeak ?? 0);
      }
    }
  }
  return out;
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
  rendererAssets: string[];
  nodeVersion: string;
  electronVersion: string;
  platform: string;
  cpuModel: string;
  cpuCount: number;
  loadavg1m: number;
  ciFlag: string | null;
  cpuAffinity: string | null;
}

function sha256File(path: string): Promise<string> {
  return readFile(path).then((buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16));
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
  const electronVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
  const cpus = os.cpus();
  return {
    recordedAt: new Date().toISOString(),
    label,
    gitSha: sha,
    gitDirty: dirty,
    mainBundleSha256: await sha256File(join(repoRoot, 'dist-electron', 'main', 'index.js')),
    preloadBundleSha256: await sha256File(join(repoRoot, 'dist-electron', 'preload', 'index.js')),
    rendererIndexSha256: await sha256File(join(repoRoot, 'dist', 'index.html')),
    rendererAssets: (await readdir(join(repoRoot, 'dist', 'assets'))).sort(),
    nodeVersion: process.version,
    electronVersion,
    platform: `${os.platform()} ${os.release()}`,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    loadavg1m: os.loadavg()[0],
    ciFlag: process.env.CI ?? null,
    cpuAffinity: process.env.CONDASH_ACCEPTANCE_AFFINITY ?? null,
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

export { summarize };
