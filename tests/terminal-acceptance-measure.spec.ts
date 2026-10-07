import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';
import { summarize, type SampleSummary } from './fixtures/acceptance-stats';
import {
  armTerminalTestSurfaces,
  checkThreshold,
  mainTailCensus,
  measureEchoFirstFrame,
  measureKeyboardEcho,
  measureSettledSwitch,
  measureTransportFloor,
  readPerfSessionCounters,
  recordIdentity,
  registryCensus,
  transportCensus,
  transportStats,
  waitForTransportBytes,
  waitForTransportText,
  type FloorMeasurement,
  type RunIdentity,
  type ThresholdCheck,
} from './fixtures/terminal-acceptance';

// The full terminal-acceptance measurement harness — env-gated on
// CONDASH_TERM_ACCEPTANCE=1 (skip-guard precedent: ui-revamp-shots.spec.ts),
// executed locally at acceptance time, never in the ordinary suite. One
// invocation = one independent run (fresh boot, n per case, identities,
// transport floors, census ledgers), written as JSON to
// tests/acceptance-out/<label>.json and evaluated against the user-approved
// threshold table (2026-10-07). Structural bounds gate regardless; threshold
// judgments belong to the CI-faithful recipe `CI=1 taskset -c 0,1`.
//
// Acceptance recipe (repo AGENTS.md, docs/explanation/terminal-acceptance.md):
//   npm run build
//   CONDASH_TERM_ACCEPTANCE=1 CONDASH_TERM_ACCEPTANCE_LABEL=run1 npm run test -- terminal-acceptance-measure.spec.ts
//   (×3, then once under) CI=1 CONDASH_TERM_ACCEPTANCE=1 taskset -c 0,1 ...
//
// No real agent/provider/network calls; the fixture's userData and conception
// are throwaway (perf-load isolation lesson).

const ECHO_TUI = resolve(__dirname, 'fixtures', 'echo-probe-tui.mjs');
const SUSTAIN = resolve(__dirname, 'fixtures', 'sustained-output-fixture.mjs');

const LABEL = process.env.CONDASH_TERM_ACCEPTANCE_LABEL ?? 'run';
const N_SAMPLES = 30; // per case, per run (3 independent runs pool to 90)
const N_KEYBOARD = 6; // separately-labelled arm, low n, never pooled (parent: n=2)
const N_RECEIPTS = 15; // chained steady-state intervals (structural case)
const RECEIPT_BYTES = 48 * 1024; // ≈3 s each at 16 KiB/s
const N_BURST_IDLE = 30; // burst-window idle ACK tokens (fast arm)
const N_FRESHNESS = 30;
const N_HIDDEN_RETURNS = 15;
const BURST_COLS = 1100; // one program line (≤1023 chars) per grid row

test.skip(
  process.env.CONDASH_TERM_ACCEPTANCE !== '1',
  'set CONDASH_TERM_ACCEPTANCE=1 to run the terminal acceptance measurement harness',
);

test.setTimeout(900_000);

// ---- the synthetic conception: the parent's corrected bound, pinned ----
// 60 ordinary + 20 scratch + 8 baseline = 88 generator files, 91 total with
// the fixture's own support files, < 5 MiB. Scratch lives under
// resources/local/ (gitignored, watcher-excluded — the parent's zero-read
// scratch result), so scratch writes carry no watcher expectation.
const N_PROBE_PROJECTS = 60;
const N_SCRATCH = 20;
const N_BASELINE_NOTES = 8;

async function writeSyntheticConception(dir: string): Promise<void> {
  const encoder = new TextEncoder();
  let totalBytes = 0;
  const write = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    totalBytes += encoder.encode(content).length;
  };
  for (let i = 1; i <= N_PROBE_PROJECTS; i++) {
    const slug = String(i).padStart(3, '0');
    await write(
      `${dir}/projects/2026-10/2026-10-${slug}-acceptance-probe/README.md`,
      `# Acceptance probe ${slug}\n\n**Status**: now\n**Kind**: project\n\n## Summary\n\nSynthetic conception probe project ${slug}.\n\n## Steps\n\n- [ ] one\n- [ ] two\n`,
    );
  }
  for (let i = 1; i <= N_BASELINE_NOTES; i++) {
    await write(
      `${dir}/knowledge/acceptance-note-${i}.md`,
      `# acceptance-note-${i}\n\nBaseline knowledge note ${i} for the terminal acceptance harness.\n`,
    );
  }
  for (let i = 1; i <= N_SCRATCH; i++) {
    await write(
      `${dir}/resources/local/acceptance-scratch/scratch-${i}.md`,
      `# scratch ${i}\n\nGitignored scratch — excluded from watcher expectations.\n`,
    );
  }
  if (totalBytes > 5 * 1024 * 1024) {
    throw new Error(`synthetic conception exceeds the 5 MiB bound: ${totalBytes}`);
  }
}

// ---- in-page freshness poller (Projects write → DOM title) ----

interface FreshnessResult {
  seenAt: number;
  timedOut: boolean;
}

async function measureFreshness(
  window: Page,
  title: string,
  write: () => Promise<void>,
  timeoutMs = 30_000,
): Promise<{ freshnessMs: number; timedOut: boolean }> {
  // Arm in-page: record the wall-clock instant the new title text shows up in
  // a Projects card title element. Wall clock (Date.now) on both sides — the
  // same host clock — keeps the node-side write timestamp comparable.
  await window.evaluate(
    ({ wanted, timeout }: { wanted: string; timeout: number }) => {
      const w = window as unknown as {
        __condashFreshness?: { wanted: string; seenAt: number; timer: number };
      };
      w.__condashFreshness = { wanted, seenAt: -1, timer: 0 };
      const t0 = Date.now();
      w.__condashFreshness.timer = window.setInterval(() => {
        const titles = document.querySelectorAll('.pane-projects h3.title');
        for (const el of titles) {
          if (el.textContent?.includes(wanted)) {
            w.__condashFreshness!.seenAt = Date.now();
            window.clearInterval(w.__condashFreshness!.timer);
            return;
          }
        }
        if (Date.now() - t0 > timeout) {
          window.clearInterval(w.__condashFreshness!.timer);
        }
      }, 4) as unknown as number;
    },
    { wanted: title, timeout: timeoutMs },
  );
  await write();
  const writtenAt = Date.now();
  const deadline = Date.now() + timeoutMs + 5_000;
  for (;;) {
    const state = await window.evaluate(() => {
      const w = window as unknown as {
        __condashFreshness?: { seenAt: number };
      };
      return w.__condashFreshness?.seenAt ?? -1;
    });
    if (state > 0) return { freshnessMs: state - writtenAt, timedOut: false };
    if (Date.now() > deadline) return { freshnessMs: -1, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---- run record ----

interface RunRecord {
  identity: RunIdentity;
  floorsStart: FloorMeasurement;
  floorsEnd: FloorMeasurement;
  bootToFirstProjectsPaintMs: number;
  firstFrameIdle: number[];
  keyboardArm: number[];
  settledSwitch: { firstMs: number[]; settledMs: number[] };
  otherIdleUnderBusy: number[];
  busySelf: number[];
  busyLoadActive: { sample: number; deltaBytes: number }[];
  receipts: { intervalMs: number; cumulativeBytes: number }[];
  receiptCounters: { batches: number; pauses: number; watchdogs: number; inFlightPeak: number };
  burst: {
    fixtureReady: string;
    resizedCols: number;
    transportFound: string[];
    transportMissing: string[];
    registryFound: string[];
    registryMissing: string[];
    registryBufferLines: number;
    mainTailFound: string[];
    mainTailMissing: string[];
    mainTailChars: number;
    achievedRateBytesPerSec: number;
    elapsedMs: number;
    idleAckDuringBurst: number[];
  };
  freshness: number[];
  knowledgeActivationMs: number;
  hiddenReturns: { returnMs: number; structurallyCorrect: boolean }[];
  wholeRunCounters: Record<
    string,
    { batches: number; pauses: number; watchdogs: number; inFlightPeak: number }
  >;
  checks: ThresholdCheck[];
  allPass: boolean;
  deviations: string[];
}

test('terminal acceptance measurement run (all probe families)', async () => {
  const booted = await bootApp({
    globalConfig: { layout: { terminal: true } },
    prepare: writeSyntheticConception,
  });
  const { window } = booted;
  window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  const runStartIso = new Date().toISOString();
  // Mechanism deviations from the plan text, carried in every record (the
  // boundary holds: tests-only, no src change, no production instrumentation):
  // (1) the attribution layer is the in-page onTermData transport accumulator
  //     instead of incremental termAttach tail reads — termAttach resets flow
  //     control mid-burst and drops the pending renderer batch, which would
  //     fabricate renderer-layer census misses; the plan's single end-of-run
  //     tail read is kept as a supplementary layer.
  // (2) the sustained-receipt wait rides delivered-byte counts from the same
  //     accumulator instead of `termList` `bytesSeen` — bytesSeen is
  //     main-process-only and not in the TermSession IPC payload, so the
  //     planned wait would have required a forbidden src change.
  const deviations = [
    'attribution layer: in-page onTermData transport accumulator (whole-run coverage) + plan end-of-run termAttach tail read; incremental mid-burst termAttach sampling rejected because termAttach resets flow control (drops pending renderer batches) and would fabricate renderer-layer misses',
    'sustained-receipt wait: delivered-byte count from the transport accumulator; termList bytesSeen does not exist in the TermSession IPC payload (main-process-only field), so the planned wait would require a src change (forbidden)',
  ];
  try {
    await armTerminalTestSurfaces(window);
    await window.evaluate(() => window.condash.perfSetEnabled(true));

    // ---- phase 0: identity, floors, boot marker ----
    const repoRoot = resolve(__dirname, '..');
    const identity = await recordIdentity(booted.app, repoRoot, LABEL);
    const floorsStart = await measureTransportFloor(window);
    const bootMarker = await window.evaluate(() => {
      return new Promise<number>((resolve) => {
        const t0 = Date.now();
        const timer = window.setInterval(() => {
          if (document.querySelectorAll('.pane-projects h3.title').length > 0) {
            window.clearInterval(timer);
            resolve(Date.now() - t0);
          }
        }, 4);
      });
    });
    const bootToFirstProjectsPaintMs = bootMarker;

    // ---- phase 1: first-useful frame, idle TUI tab (buffer level) ----
    const echo = await spawnAndWaitReady(window, ECHO_TUI, '');
    const firstFrameIdle: number[] = [];
    for (let i = 0; i < N_SAMPLES; i++) {
      const sample = await measureEchoFirstFrame(
        window,
        echo.sid,
        `P1${String(i).padStart(3, '0')}`,
      );
      expect(sample.timedOut, `first-frame sample ${i} timed out`).toBe(false);
      firstFrameIdle.push(sample.firstMs);
    }

    // ---- phase 2: keyboard-dispatch arm (separately labelled, not pooled) ----
    await window.click(`[data-sid="${echo.sid}"]`);
    await window.locator('.terminal-host .xterm-screen').first().click();
    const keyboardArm: number[] = [];
    for (let i = 0; i < N_KEYBOARD; i++) {
      const sample = await measureKeyboardEcho(
        window,
        echo.sid,
        `PK${String(i).padStart(3, '0')}`,
        (text) => window.keyboard.type(text, { delay: 5 }),
      );
      expect(sample.timedOut, `keyboard sample ${i} timed out`).toBe(false);
      keyboardArm.push(sample.firstMs);
    }

    // ---- phase 3: settled tab switch (hydrate + settlement) ----
    const other = await window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "OTHER-MEASURE\\n"; sleep 600' }),
    );
    await window.waitForSelector(`[data-sid="${other.id}"]`, { state: 'attached' });
    await window.click(`[data-sid="${other.id}"]`); // demote echo into the worker
    const settledSwitch = { firstMs: [], settledMs: [] } as {
      firstMs: number[];
      settledMs: number[];
    };
    for (let i = 0; i < N_SAMPLES; i++) {
      const sample = await measureSettledSwitch(
        window,
        echo.sid,
        `P2${String(i).padStart(3, '0')}`,
      );
      expect(sample.timedOut, `settled-switch sample ${i} timed out`).toBe(false);
      settledSwitch.firstMs.push(sample.firstMs);
      settledSwitch.settledMs.push(sample.settledMs ?? -1);
      // Re-hide for the next sample.
      await window.click(`[data-sid="${other.id}"]`);
    }

    // ---- phase 4: busy vs other-idle at pinned 16 KiB/s ----
    const busy = await spawnAndWaitReady(
      window,
      SUSTAIN,
      ` --mode sustain --rate ${16 * 1024} --budget ${2048 * 1024} --seed 90210 --echo`,
    );
    const idle = await spawnAndWaitReady(window, ECHO_TUI, '');
    const otherIdleUnderBusy: number[] = [];
    const busySelf: number[] = [];
    const busyLoadActive: { sample: number; deltaBytes: number }[] = [];
    let busyBytesBefore = (await transportStats(window, busy.sid)).bytes;
    for (let i = 0; i < N_SAMPLES; i++) {
      // Count-scheduled arm order: every 2nd sample, strictly alternating.
      const idleSample = await measureEchoFirstFrame(
        window,
        idle.sid,
        `P3I${String(i).padStart(3, '0')}`,
      );
      expect(idleSample.timedOut, `other-idle sample ${i} timed out`).toBe(false);
      otherIdleUnderBusy.push(idleSample.firstMs);
      const busySample = await measureEchoFirstFrame(
        window,
        busy.sid,
        `P3B${String(i).padStart(3, '0')}`,
      );
      expect(busySample.timedOut, `busy-self sample ${i} timed out`).toBe(false);
      busySelf.push(busySample.firstMs);
      const busyBytesAfter = (await transportStats(window, busy.sid)).bytes;
      busyLoadActive.push({ sample: i, deltaBytes: busyBytesAfter - busyBytesBefore });
      busyBytesBefore = busyBytesAfter;
    }

    // ---- phase 5: sustained receipt (fixed byte budget, chained intervals) ----
    const receiptTotal = N_RECEIPTS * RECEIPT_BYTES;
    const receiptsSustainer = await spawnAndWaitReady(
      window,
      SUSTAIN,
      ` --mode sustain --rate ${16 * 1024} --budget ${receiptTotal} --seed 314159 --echo`,
    );
    const receipts: { intervalMs: number; cumulativeBytes: number }[] = [];
    let prevAt = Date.now();
    for (let i = 1; i <= N_RECEIPTS; i++) {
      const mark = i * RECEIPT_BYTES;
      const waited = await waitForTransportBytes(window, receiptsSustainer.sid, mark + 256, 60_000);
      expect(waited.timedOut, `receipt ${i} never reached ${mark} delivered bytes`).toBe(false);
      const now = Date.now();
      receipts.push({ intervalMs: now - prevAt, cumulativeBytes: waited.bytes });
      prevAt = now;
    }
    await waitForTransportText(window, receiptsSustainer.sid, 'DONE');
    const receiptCounters = (
      await readPerfSessionCounters(booted.conceptionDir, runStartIso, new Date().toISOString(), [
        receiptsSustainer.sid,
      ])
    )[receiptsSustainer.sid];
    expect(receiptCounters.watchdogs, 'watchdogs === 0 under the sustained receipt load').toBe(0);

    // ---- phase 6: burst identity + two-layer received-token census ----
    const burst = await spawnAndWaitReady(
      window,
      SUSTAIN,
      ' --mode burst --seed 271828 --hold',
      'SUSTAIN-READY',
    );
    // One program line per grid row: resize BEFORE generation starts, behind
    // the settled barrier, so the whole burst fits the 5,000-line scrollback.
    await window.evaluate(({ id, cols, rows }) => window.condash.termResize(id, cols, rows), {
      id: burst.sid,
      cols: BURST_COLS,
      rows: 24,
    });
    await expect
      .poll(
        async () => {
          const state = await window.evaluate((id: string) => {
            const term = (
              window as unknown as {
                __condashXterms?: Map<string, { cols: number; rows: number }>;
              }
            ).__condashXterms?.get(id);
            return term ? { cols: term.cols, rows: term.rows } : { cols: -1, rows: -1 };
          }, burst.sid);
          return state.cols;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(1024);
    const burstTokenNeedles = Array.from(
      { length: 64 },
      (_, i) => `TKN-${String(i).padStart(3, '0')}`,
    );
    const burstIdleAck: number[] = [];
    await window.evaluate((id) => window.condash.termWrite(id, 'GO'), burst.sid);
    const burstStartedAt = Date.now();
    let burstIdleIndex = 0;
    for (let j = 1; j <= N_BURST_IDLE && burstIdleIndex < N_BURST_IDLE; j++) {
      // Count-scheduled against the product surface: the next idle token fires
      // when the burst tab's delivered bytes cross the next 1/31 mark.
      const mark = Math.floor((3_932_160 * j) / (N_BURST_IDLE + 1));
      await waitForTransportBytes(window, burst.sid, mark, 60_000);
      const sample = await measureEchoFirstFrame(
        window,
        idle.sid,
        `P5I${String(burstIdleIndex).padStart(3, '0')}`,
      );
      expect(sample.timedOut, `burst-window idle ACK ${burstIdleIndex} timed out`).toBe(false);
      burstIdleAck.push(sample.firstMs);
      burstIdleIndex++;
    }
    const burstDone = await waitForTransportText(window, burst.sid, 'DONE', 120_000);
    expect(burstDone.timedOut, 'burst never reached its DONE sentinel').toBe(false);
    const burstElapsedMs = Date.now() - burstStartedAt;
    const burstFinal = await transportStats(window, burst.sid);

    // Census layer 1: delivered stream (exhaustive by construction).
    const burstTransport = await transportCensus(window, burst.sid, burstTokenNeedles);
    // Census layer 2: renderer registry (the acceptance signal).
    const burstRegistry = await registryCensus(window, burst.sid, burstTokenNeedles);
    // Census layer 3 (supplementary, the plan's main-side tail): the single
    // end-of-run termAttach read — safe now that output has stopped.
    const burstTail = await mainTailCensus(window, burst.sid, burstTokenNeedles);

    // The ledger: every token accounted, with layer attribution. A renderer
    // miss is a finding to investigate before acceptance — never pooled,
    // never auto-passed.
    const ledger = burstTokenNeedles.map((needle) => {
      const inTransport = burstTransport.found.includes(needle);
      const inRegistry = burstRegistry.found.includes(needle);
      const inTail = burstTail.found.includes(needle);
      const attribution = inRegistry
        ? 'received'
        : inTransport
          ? 'renderer/parse/hydrate (delivered, never parsed)'
          : inTail
            ? 'main-side tail only (renderer never delivered it live)'
            : 'attribution-unavailable';
      return { needle, inTransport, inRegistry, inTail, attribution };
    });
    const unexplained = ledger.filter((entry) => entry.attribution !== 'received');
    expect(
      unexplained,
      `burst census: ${unexplained.length}/64 tokens not received — ledger: ${JSON.stringify(unexplained)}`,
    ).toEqual([]);

    // ---- phase 7: non-terminal views on the synthetic conception ----
    // The Projects pane must be the visible surface: the freshness condition
    // is card-title text in `.pane-projects`.
    await window.locator('.rail').getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(window.getByText('Acceptance probe 001').first()).toBeVisible({ timeout: 15_000 });
    const freshness: number[] = [];
    for (let i = 0; i < N_FRESHNESS; i++) {
      const projectIndex = (i % N_PROBE_PROJECTS) + 1;
      const slug = String(projectIndex).padStart(3, '0');
      const title = `Acceptance probe ${slug} rev ${i}`;
      const readme = `${booted.conceptionDir}/projects/2026-10/2026-10-${slug}-acceptance-probe/README.md`;
      const sample = await measureFreshness(window, title, async () => {
        await writeFile(
          readme,
          `# ${title}\n\n**Status**: now\n**Kind**: project\n\n## Summary\n\nSynthetic conception probe project ${slug}.\n\n## Steps\n\n- [ ] one\n- [ ] two\n`,
          'utf8',
        );
      });
      expect(sample.timedOut, `freshness sample ${i}: "${title}" never reached the DOM`).toBe(
        false,
      );
      freshness.push(sample.freshnessMs);
    }

    // Knowledge first-open activation (descriptive — unthresholded, review M4).
    const knowledgeActivationMs = await armAndMeasureClick(
      window,
      async () => {
        await window
          .locator('.rail')
          .getByRole('button', { name: 'Knowledge', exact: true })
          .click();
      },
      'acceptance-note-3',
    );

    // Hidden returns: terminal↔Knowledge cycles behind the settlement barrier.
    // The echo tab must be the band's ACTIVE tab, so the return hydrates IT.
    await window.click(`[data-sid="${echo.sid}"]`);
    const hiddenReturns: { returnMs: number; structurallyCorrect: boolean }[] = [];
    for (let i = 0; i < N_HIDDEN_RETURNS; i++) {
      const outcome = await measureHiddenReturn(
        window,
        echo.sid,
        `P6R${String(i).padStart(3, '0')}`,
        async () => {
          await window
            .locator('.rail')
            .getByRole('button', { name: 'Knowledge', exact: true })
            .click();
        },
      );
      hiddenReturns.push(outcome);
    }
    const structurallyCorrectCount = hiddenReturns.filter((r) => r.structurallyCorrect).length;
    expect(
      structurallyCorrectCount,
      `hidden returns: ${structurallyCorrectCount}/${N_HIDDEN_RETURNS} structurally correct`,
    ).toBe(N_HIDDEN_RETURNS);

    // ---- phase 8: final floors, whole-run counters, record ----
    const floorsEnd = await measureTransportFloor(window);
    const wholeRunCounters = await readPerfSessionCounters(
      booted.conceptionDir,
      runStartIso,
      new Date().toISOString(),
      [echo.sid, other.id, busy.sid, idle.sid, receiptsSustainer.sid, burst.sid],
    );
    for (const [sid, flow] of Object.entries(wholeRunCounters)) {
      expect(flow.watchdogs, `watchdogs === 0 over the whole run for ${sid}`).toBe(0);
    }

    const dist = (samples: number[]): SampleSummary => summarize(samples);
    const floor = floorsEnd.emptyMedianMs;
    const checks: ThresholdCheck[] = [
      checkThreshold('first-useful frame, idle TUI tab (buffer level)', dist(firstFrameIdle), {
        medianBound: 400,
        p95Bound: 800,
      }),
      checkThreshold('other-idle probe under one busy 16 KiB/s tab', dist(otherIdleUnderBusy), {
        medianBound: 120,
        p95Bound: 250,
      }),
      checkThreshold('busy-tab self probe (16 KiB/s)', dist(busySelf), {
        medianBound: 400,
        p95Bound: 500,
      }),
      checkThreshold('settled tab switch (hydrate + settlement)', dist(settledSwitch.settledMs), {
        medianBound: 1000,
        p95Bound: 2000,
      }),
      checkThreshold('Projects write→DOM on the larger synthetic conception', dist(freshness), {
        medianBound: 700,
        p95Bound: 1000,
      }),
      checkThreshold(
        'hidden return terminal↔Knowledge',
        dist(hiddenReturns.map((r) => r.returnMs)),
        {
          medianBound: 250,
        },
      ),
      checkThreshold(
        'sustained receipt (fixed byte budget)',
        dist(receipts.map((r) => r.intervalMs)),
        {
          structuralOnly: true,
        },
      ),
      checkThreshold('burst token census (128 KiB/s × 30 s + 100-line probe)', dist([0]), {
        structuralOnly: true,
      }),
      checkThreshold('probe-overhead validity: transport floor', dist([floorsEnd.emptyMedianMs]), {
        medianBound: 15,
      }),
    ];

    // Fast arms report floor-relative overhead instead of invalidation (O2).
    const fastArms = {
      'one-busy other-idle': dist(otherIdleUnderBusy).median / floor,
      'burst-window idle ACK': dist(burstIdleAck).median / floor,
      'hidden return': dist(hiddenReturns.map((r) => r.returnMs)).median / floor,
      'keyboard arm': dist(keyboardArm).median / floor,
    };

    // Scoped 5× validity bound: the arms whose parent baselines clear 75 ms.
    const scopedInvalid: string[] = [];
    const scopedArms: Record<string, number> = {
      'idle first-frame': dist(firstFrameIdle).median,
      'busy-self': dist(busySelf).median,
      'settled switch': dist(settledSwitch.settledMs).median,
      freshness: dist(freshness).median,
    };
    for (const [arm, median] of Object.entries(scopedArms)) {
      if (median < 5 * floor)
        scopedInvalid.push(
          `${arm}: median ${median.toFixed(1)} < 5×floor ${(5 * floor).toFixed(1)}`,
        );
    }
    checks.push(
      checkThreshold(
        'probe-overhead validity: scoped 5× floor (idle first-frame, busy-self, settled, freshness)',
        dist([scopedInvalid.length]),
        { structuralOnly: true },
      ),
    );

    const allPass = checks.every((c) => c.pass) && scopedInvalid.length === 0;

    const record: RunRecord = {
      identity,
      floorsStart,
      floorsEnd,
      bootToFirstProjectsPaintMs,
      firstFrameIdle,
      keyboardArm,
      settledSwitch,
      otherIdleUnderBusy,
      busySelf,
      busyLoadActive,
      receipts,
      receiptCounters,
      burst: {
        fixtureReady: 'pinned identity asserted by the fixture self-checks',
        resizedCols: BURST_COLS,
        transportFound: burstTransport.found,
        transportMissing: burstTransport.missing,
        registryFound: burstRegistry.found,
        registryMissing: burstRegistry.missing,
        registryBufferLines: burstRegistry.bufferLines,
        mainTailFound: burstTail.found,
        mainTailMissing: burstTail.missing,
        mainTailChars: burstTail.tailChars,
        achievedRateBytesPerSec: Math.round(
          (burstFinal.bytes / Math.max(1, burstElapsedMs)) * 1000,
        ),
        elapsedMs: burstElapsedMs,
        idleAckDuringBurst: burstIdleAck,
      },
      freshness,
      knowledgeActivationMs,
      hiddenReturns,
      wholeRunCounters,
      checks,
      allPass,
      deviations,
    };

    await mkdir(resolve(__dirname, 'acceptance-out'), { recursive: true });
    await writeFile(
      resolve(__dirname, 'acceptance-out', `${LABEL}.json`),
      JSON.stringify(record, null, 2),
      'utf8',
    );

    // Console summary — the readable acceptance table for the record.
    console.log(`\n=== terminal acceptance run "${LABEL}" ===`);
    console.log(
      `transport floor: empty ${floor.toFixed(1)} ms | registry-read ${floorsEnd.registryReadMedianMs.toFixed(1)} ms | delta ${floorsEnd.registryDeltaMs.toFixed(1)} ms (${floorsEnd.samples} samples)`,
    );
    for (const check of checks) {
      console.log(`${check.pass ? 'PASS' : 'FAIL'} | ${check.probe} | ${check.detail}`);
    }
    console.log('fast arms (floor-relative overhead, not invalidation):');
    for (const [arm, ratio] of Object.entries(fastArms)) {
      console.log(`  ${arm}: ${ratio.toFixed(1)}× floor`);
    }
    if (scopedInvalid.length > 0) {
      console.log(`scoped 5× validity bound VIOLATED: ${scopedInvalid.join('; ')}`);
    }
    console.log(
      `burst achieved rate ≈ ${record.burst.achievedRateBytesPerSec} B/s over ${burstElapsedMs} ms; registry buffer ${burstRegistry.bufferLines} lines`,
    );
    console.log(`whole-run flow counters: ${JSON.stringify(wholeRunCounters)}`);
    console.log(`ALL PASS: ${allPass}\n`);

    expect(
      allPass,
      `acceptance thresholds failed — see tests/acceptance-out/${LABEL}.json and the summary above`,
    ).toBe(true);

    for (const id of [echo.sid, other.id, busy.sid, idle.sid, receiptsSustainer.sid, burst.sid]) {
      await window.evaluate((sid) => window.condash.termClose(sid), id);
    }
  } finally {
    await booted.cleanup();
  }
});

// ---- helpers shared by the phases ----

interface SpawnedTab {
  sid: string;
  readyLine: string;
}

async function spawnAndWaitReady(
  window: Page,
  script: string,
  args: string,
  readyMarker = 'ECHO-PROBE READY',
): Promise<SpawnedTab> {
  const spawned = await window.evaluate(
    ({ scriptPath, scriptArgs }) =>
      window.condash.termSpawn({ side: 'my', command: `node ${scriptPath}${scriptArgs}` }),
    { scriptPath: script, scriptArgs: args },
  );
  await window.waitForSelector(`[data-sid="${spawned.id}"]`, { state: 'attached' });
  await waitForTransportText(window, spawned.id, readyMarker, 15_000);
  return { sid: spawned.id, readyLine: readyMarker };
}

/** Arm an in-page wall-clock poller for `wanted` text, click via node, collect. */
async function armAndMeasureClick(
  window: Page,
  click: () => Promise<void>,
  wanted: string,
  timeoutMs = 30_000,
): Promise<number> {
  await window.evaluate(
    ({ wantedText, timeout }: { wantedText: string; timeout: number }) => {
      const w = window as unknown as {
        __condashClickProbe?: { wanted: string; seenAt: number; timer: number };
      };
      w.__condashClickProbe = { wanted: wantedText, seenAt: -1, timer: 0 };
      const t0 = Date.now();
      w.__condashClickProbe.timer = window.setInterval(() => {
        if (document.body?.innerText.includes(wantedText)) {
          w.__condashClickProbe!.seenAt = Date.now();
          window.clearInterval(w.__condashClickProbe!.timer);
          return;
        }
        if (Date.now() - t0 > timeout) window.clearInterval(w.__condashClickProbe!.timer);
      }, 4) as unknown as number;
    },
    { wantedText: wanted, timeout: timeoutMs },
  );
  await click();
  const clickedAt = Date.now();
  const deadline = Date.now() + timeoutMs + 5_000;
  for (;;) {
    const seenAt = await window.evaluate(() => {
      const w = window as unknown as { __condashClickProbe?: { seenAt: number } };
      return w.__condashClickProbe?.seenAt ?? -1;
    });
    if (seenAt > 0) return seenAt - clickedAt;
    if (Date.now() > deadline) return -1;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * One hidden-return sample: send a fresh probe token to the (hidden) echo tab,
 * switch to Knowledge, then click the Terminal rail button and measure the
 * DOM return — the tab's DOM Terminal mounted AND the post-return ACK parsed
 * (structurally correct = the sentinel survived the demote/hydrate cycle).
 * Fast arm: floor-relative overhead, never the 5× invalidation (review O2).
 */
async function measureHiddenReturn(
  window: Page,
  sid: string,
  token: string,
  goKnowledge: () => Promise<void>,
): Promise<{ returnMs: number; structurallyCorrect: boolean }> {
  await window.evaluate((id) => window.condash.termWrite(id, token), sid);
  await goKnowledge();
  // Knowledge must be visibly open — a known baseline note title — before the
  // return is measured; otherwise the return would start from mid-transition.
  await expect(window.getByText('acceptance-note-3')).toBeVisible({ timeout: 15_000 });
  await window.locator('.rail').getByRole('button', { name: 'Terminal', exact: true }).click();
  const outcome = await window.evaluate(
    ({ id, probeToken, timeout }: { id: string; probeToken: string; timeout: number }) => {
      return new Promise<{ returnMs: number; structurallyCorrect: boolean }>((resolve) => {
        const w = window as unknown as {
          __condashXterms?: Map<
            string,
            {
              rows: number;
              buffer: {
                active: {
                  baseY: number;
                  getLine(y: number): { translateToString(trim?: boolean): string } | undefined;
                };
              };
            }
          >;
        };
        const t0 = Date.now();
        const timer = window.setInterval(() => {
          const term = w.__condashXterms?.get(id);
          const elapsed = Date.now() - t0;
          if (term) {
            const buffer = term.buffer.active;
            for (let y = 0; y < term.rows; y++) {
              const line = buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '';
              if (line.includes('ACK ' + probeToken)) {
                window.clearInterval(timer);
                resolve({ returnMs: elapsed, structurallyCorrect: true });
                return;
              }
            }
          }
          if (elapsed > timeout) {
            window.clearInterval(timer);
            resolve({ returnMs: -1, structurallyCorrect: false });
          }
        }, 4) as unknown as number;
      });
    },
    { id: sid, probeToken: token, timeout: 15_000 },
  );
  return outcome;
}
