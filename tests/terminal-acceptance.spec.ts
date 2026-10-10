import { resolve } from 'node:path';
import { cp, writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';
import {
  armTerminalTestSurfaces,
  disposeTerminalTestSurfaces,
  measureEchoFirstFrame,
  measureSettledSwitch,
  registryCensus,
  settledGeometry,
  startTelemetryHeartbeat,
  startPayload,
  transportCensus,
  waitForPayload,
  waitForPerfEvidence,
  waitForTransportText,
} from './fixtures/terminal-acceptance';

const ECHO = resolve(__dirname, 'fixtures/echo-probe-tui.mjs');
const SUSTAIN = resolve(__dirname, 'fixtures/sustained-output-fixture.mjs');
test.setTimeout(180_000);

test('terminal acceptance surfaces: mini census, watchdog bound, probe markers, absorb control', async ({}, testInfo) => {
  const booted = await bootApp({
    globalConfig: {
      layout: { terminal: true },
      terminal: { memory: { enabled: false, appScope: { enabled: false } } },
      autoSync: { enabled: false },
      dashboard: { enabled: false },
    },
  });
  const page = booted.window;
  try {
    await armTerminalTestSurfaces(page);
    const since = await startTelemetryHeartbeat(page, booted.conceptionDir);
    const sustain = await page.evaluate(
      (script) =>
        window.condash.termSpawn({
          side: 'my',
          command: `node '${script}' --rate 16384 --budget 65536 --tokens 8 --lineBytes 511 --seed 424242 --hold`,
        }),
      SUSTAIN,
    );
    await page.waitForSelector(`[data-sid="${sustain.id}"]`);
    await expect
      .poll(async () => (await registryCensus(page, sustain.id, ['SUSTAIN-READY'])).found.length)
      .toBe(1);
    await settledGeometry(page, sustain.id);
    await startPayload(page, sustain.id, 65536);
    const receipt = await waitForPayload(page, sustain.id, 65536, true);
    expect(receipt.payloadBytes).toBe(65536);
    expect(receipt.scheduledBytes).toBe(65536);
    expect(receipt.timing?.observedPayloadBytes).toBe(65536);
    expect(typeof receipt.timing?.fullReceiptMs).toBe('number');
    expect(receipt.timing?.completionMs).toBeGreaterThanOrEqual(receipt.timing!.fullReceiptMs!);
    await expect
      .poll(async () => (await registryCensus(page, sustain.id, ['PAYLOAD-END'])).found.length)
      .toBe(1);
    const tokens = Array.from({ length: 8 }, (_, index) => `TKN-${String(index).padStart(3, '0')}`);
    expect((await transportCensus(page, sustain.id, tokens)).missing).toEqual([]);
    expect((await registryCensus(page, sustain.id, tokens)).missing).toEqual([]);

    const echo = await page.evaluate(
      (script) => window.condash.termSpawn({ side: 'my', command: `node '${script}'` }),
      ECHO,
    );
    await page.waitForSelector(`[data-sid="${echo.id}"]`);
    await expect
      .poll(async () => (await registryCensus(page, echo.id, ['ECHO-PROBE READY'])).found.length)
      .toBe(1);
    const first = await measureEchoFirstFrame(page, echo.id, 'P9001');
    expect(first.timedOut).toBe(false);
    expect(first.firstMs).toBeGreaterThan(0);
    await settledGeometry(page, echo.id);
    await page.locator(`[data-sid="${sustain.id}"]`).click();
    await settledGeometry(page, sustain.id);
    const transition = await measureSettledSwitch(page, echo.id, 'P9002');
    expect(transition.timedOut).toBe(false);
    expect(transition.settledMs).toBeGreaterThanOrEqual(transition.firstMs);
    await settledGeometry(page, echo.id);

    const absorber = await page.evaluate(
      (script) => window.condash.termSpawn({ side: 'my', command: `node '${script}' --absorb` }),
      ECHO,
    );
    await page.waitForSelector(`[data-sid="${absorber.id}"]`);
    await expect
      .poll(
        async () => (await registryCensus(page, absorber.id, ['ECHO-PROBE READY'])).found.length,
      )
      .toBe(1);
    await page.evaluate((id) => window.condash.termWrite(id, 'P7001 P7002 F'), absorber.id);
    await waitForTransportText(page, absorber.id, 'FROZEN');
    await settledGeometry(page, absorber.id);
    expect((await registryCensus(page, absorber.id, ['ACK P7001', 'ACK P7002'])).found).toEqual([]);
    expect((await transportCensus(page, absorber.id, ['ACK P7001', 'ACK P7002'])).found).toEqual(
      [],
    );

    const telemetry = await waitForPerfEvidence(
      booted.conceptionDir,
      since,
      new Date().toISOString(),
      [sustain.id, echo.id, absorber.id],
    );
    await writeFile(testInfo.outputPath('telemetry.json'), JSON.stringify(telemetry, null, 2));
    for (const counters of Object.values(telemetry.counters)) {
      expect(counters.batches).toBeGreaterThan(0);
      expect(counters.bytes).toBeGreaterThan(0);
      expect(counters.activityWindows).toBeGreaterThan(0);
      expect(counters.watchdogs).toBe(0);
    }
  } finally {
    await cp(booted.conceptionDir, testInfo.outputPath('fixture'), { recursive: true });
    await disposeTerminalTestSurfaces(page).catch(() => undefined);
    await booted.cleanup();
  }
});
