import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';
import {
  armTerminalTestSurfaces,
  measureEchoFirstFrame,
  measureSettledSwitch,
  readPerfSessionCounters,
  registryCensus,
  transportCensus,
  transportStats,
  waitForTransportText,
} from './fixtures/terminal-acceptance';

// The always-on structural half of the terminal-acceptance harness (plan:
// "keeps the contracts exercised in the ordinary suite"). Structural bounds
// gate regardless of any threshold: a small token census is complete on BOTH
// layers, one first-frame and one settled sample each yield their markers, a
// watchdog never fires under the acceptance load, and the absorb fixture
// proves the census detects absence. Every wait here is a product-exposed
// condition — registry text, delivered-byte counts, DONE sentinels — never a
// duration. The full env-gated distribution harness lives in
// terminal-acceptance-measure.spec.ts (CONDASH_TERM_ACCEPTANCE=1).

const ECHO_TUI = resolve(__dirname, 'fixtures', 'echo-probe-tui.mjs');
const SUSTAIN = resolve(__dirname, 'fixtures', 'sustained-output-fixture.mjs');

const MINI_TOKENS = 8; // in-stream census population for the mini case
const MINI_RATE = 16 * 1024;
const MINI_BUDGET = 64 * 1024; // ≈4 s at MINI_RATE

test.setTimeout(180_000);

test('terminal acceptance surfaces: mini census, watchdog bound, probe markers, absorb control', async () => {
  const booted = await bootApp({ globalConfig: { layout: { terminal: true } } });
  const { window } = booted;
  window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  const perfSinceIso = new Date().toISOString();
  try {
    await armTerminalTestSurfaces(window);

    // Opt into the perf recorder for the whole case window — the throwaway
    // fixture settings only (perf-load isolation lesson).
    await window.evaluate(() => window.condash.perfSetEnabled(true));

    // ---- mini census: sustained fixture, 8 in-stream tokens, both layers ----
    const sustain = await window.evaluate(
      (script) =>
        window.condash.termSpawn({
          side: 'my',
          command: `node ${script} --mode sustain --rate ${16 * 1024} --budget ${64 * 1024} --tokens 8 --lineBytes 511 --seed 424242`,
        }),
      SUSTAIN,
    );
    await window.waitForSelector(`[data-sid="${sustain.id}"]`, { state: 'attached' });
    await waitForTransportText(window, sustain.id, 'SUSTAIN-READY');
    // The generator pins its own identity; the census population is exactly 8.
    const tokenNeedles = Array.from(
      { length: MINI_TOKENS },
      (_, i) => `TKN-${String(i).padStart(3, '0')}`,
    );
    await waitForTransportText(window, sustain.id, 'DONE');
    const transport = await transportCensus(window, sustain.id, tokenNeedles);
    expect(transport.missing, 'transport layer: every token delivered').toEqual([]);
    const registry = await registryCensus(window, sustain.id, tokenNeedles);
    expect(registry.missing, 'registry layer: every token parsed').toEqual([]);
    // Delivered bytes cover the pinned budget (plus READY/DONE lines and any
    // echo traffic) — the receipt bound the census window rests on.
    const stats = await transportStats(window, sustain.id);
    expect(stats.bytes).toBeGreaterThanOrEqual(MINI_BUDGET);

    // ---- first-frame: one sample, marker yielded, visible on both layers ----
    const echo = await window.evaluate(
      (script) => window.condash.termSpawn({ side: 'my', command: `node ${script}` }),
      ECHO_TUI,
    );
    await window.waitForSelector(`[data-sid="${echo.id}"]`, { state: 'attached' });
    await waitForTransportText(window, echo.id, 'ECHO-PROBE READY');
    const frame = await measureEchoFirstFrame(window, echo.id, 'P9001');
    expect(frame.timedOut, 'first-frame sample yields its marker').toBe(false);
    expect(frame.firstMs).toBeGreaterThan(0);
    const frameEcho = await transportCensus(window, echo.id, ['ACK P9001']);
    expect(frameEcho.found).toEqual(['ACK P9001']);
    const frameRegistry = await registryCensus(window, echo.id, ['ACK P9001']);
    expect(frameRegistry.missing).toEqual([]);

    // ---- settled switch: one sample, BOTH markers yielded ----
    const other = await window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "OTHER-ACCEPT\\n"; sleep 300' }),
    );
    await window.waitForSelector(`[data-sid="${other.id}"]`, { state: 'attached' });
    // Switching to `other` demotes the echo tab into the worker.
    await window.click(`[data-sid="${other.id}"]`);
    const settled = await measureSettledSwitch(window, echo.id, 'P9002');
    expect(settled.timedOut, 'settled-switch sample yields both markers').toBe(false);
    expect(settled.firstMs).toBeGreaterThan(0);
    expect(settled.settledMs).toBeGreaterThanOrEqual(settled.firstMs);
    expect(settled.cols, 'grid reads only behind the settled barrier').toBeGreaterThan(0);
    expect(settled.rows).toBeGreaterThan(0);

    // ---- watchdog bound: no saturation signal in the whole case window ----
    const counters = await readPerfSessionCounters(
      booted.conceptionDir,
      perfSinceIso,
      new Date().toISOString(),
      [sustain.id, echo.id, other.id],
    );
    for (const [sid, flow] of Object.entries(counters)) {
      expect(flow.watchdogs, `watchdogs === 0 for ${sid} (the saturation signal)`).toBe(0);
      // Pauses are recorded and reported, never asserted (plan probe 4).
      console.log(
        `acceptance-structural ${sid}: pauses=${flow.pauses} batches=${flow.batches} inFlightPeak=${flow.inFlightPeak}`,
      );
    }

    // ---- absorb control: the fixture swallows stdin silently, so there is
    // nothing to wait FOR — the tokens are written now and their absence is
    // asserted at end-of-window against the product state (zero delivered
    // bytes, zero ACK lines parsed). An absorber that echoed would show both.
    const absorber = await window.evaluate(
      (script) => window.condash.termSpawn({ side: 'my', command: `node ${script} --absorb` }),
      ECHO_TUI,
    );
    await window.waitForSelector(`[data-sid="${absorber.id}"]`, { state: 'attached' });
    await waitForTransportText(window, absorber.id, 'ECHO-PROBE READY');
    // The boot READY header is the absorber's only legitimate output; measure
    // everything it delivers AFTER it, so the end-of-window verdict is about
    // the swallowed tokens, not the header.
    const absorbedBaseline = (await transportStats(window, absorber.id)).bytes;
    await window.evaluate((id) => window.condash.termWrite(id, 'P7001 P7002'), absorber.id);

    // ---- absorb control's end-of-window verdict (see the write above) ----
    const absorbedStats = await transportStats(window, absorber.id);
    expect(
      absorbedStats.bytes - absorbedBaseline,
      'absorb mode delivered nothing back (no echo, no output beyond the boot header)',
    ).toBe(0);
    const absorbed = await registryCensus(window, absorber.id, ['ACK P7001', 'ACK P7002']);
    expect(absorbed.found, 'absorb mode swallows tokens: no ACK ever parsed').toEqual([]);

    for (const id of [sustain.id, echo.id, other.id, absorber.id]) {
      await window.evaluate((sid) => window.condash.termClose(sid), id);
    }
  } finally {
    await booted.cleanup();
  }
});
