import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';
import { summarize } from './fixtures/acceptance-stats';
import {
  armTerminalTestSurfaces,
  burstCensus,
  checkThreshold,
  classifyAcceptanceReport,
  deliveredPayload,
  disposeTerminalTestSurfaces,
  measureEchoFirstFrame,
  measureHiddenBandReturn,
  measureKeyboardEcho,
  measureSettledSwitch,
  measureTransportFloor,
  measureObserverOverhead,
  isLoadedAck,
  prepareBurstRetention,
  recordIdentity,
  registryCensus,
  requiredWrappedRows,
  settledGeometry,
  startTelemetryHeartbeat,
  startPayload,
  transportStats,
  waitForDomTerm,
  waitForPayload,
  waitForPerfEvidence,
  type ProbeOutcome,
} from './fixtures/terminal-acceptance';

const ECHO = resolve(__dirname, 'fixtures/echo-probe-tui.mjs');
const SUSTAIN = resolve(__dirname, 'fixtures/sustained-output-fixture.mjs');
const SAMPLES = 30;
const KEYBOARD_SAMPLES = 6;
const RECEIPT_BYTES = 48 * 1024;
const BURST_BYTES = 3_932_160;
const SCROLLBACK = 50_000;

test.skip(process.env.CONDASH_TERM_ACCEPTANCE !== '1', 'set CONDASH_TERM_ACCEPTANCE=1');
test.setTimeout(900_000);
// Independent boots have independent labels; retries are not acceptance repetitions.
test.describe.configure({ retries: 0 });

async function syntheticConception(dir: string): Promise<void> {
  // Exactly 88 conception Markdown files, including the two bootApp baselines.
  // Three user/repo support documents outside the conception make 91 in the fixture.
  const write = async (path: string, body: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  };
  for (let index = 1; index <= 59; index++) {
    const slug = String(index).padStart(3, '0');
    await write(
      join(dir, `projects/2026-10/2026-10-08-acceptance-${slug}/README.md`),
      `# Acceptance probe ${slug}\n\n**Status**: now\n**Kind**: project\n`,
    );
  }
  for (let index = 1; index <= 7; index++)
    await write(
      join(dir, `knowledge/acceptance-note-${index}.md`),
      `# acceptance-note-${index}\n\nBaseline note ${index}.\n`,
    );
  for (let index = 1; index <= 20; index++)
    await write(
      join(dir, `resources/local/acceptance-scratch/scratch-${index}.md`),
      `# scratch ${index}\n`,
    );
}

async function countFixture(dir: string): Promise<{ markdownFiles: number; bytes: number }> {
  let markdownFiles = 0;
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        markdownFiles++;
        bytes += (await readFile(path)).length;
      }
    }
  };
  await walk(dir);
  return { markdownFiles, bytes };
}

async function spawn(
  page: Page,
  script: string,
  args = '',
  ready = 'ECHO-PROBE READY',
): Promise<string> {
  const { id } = await page.evaluate(
    ({ script, args }) =>
      window.condash.termSpawn({ side: 'my', command: `node '${script}' ${args}` }),
    { script, args },
  );
  await page.waitForSelector(`[data-sid="${id}"]`);
  await page.locator(`[data-sid="${id}"]`).click();
  await waitForDomTerm(page, id);
  await expect.poll(async () => (await registryCensus(page, id, [ready])).found.length).toBe(1);
  await settledGeometry(page, id);
  return id;
}

async function activate(page: Page, sid: string): Promise<void> {
  await page.locator(`[data-sid="${sid}"]`).click();
  await waitForDomTerm(page, sid);
  await settledGeometry(page, sid);
}

async function visibleKnowledge(page: Page): Promise<void> {
  if (!(await page.getByText('acceptance-note-3', { exact: true }).isVisible())) {
    await page.locator('.rail').getByRole('button', { name: 'Knowledge', exact: true }).click();
  }
  await expect(page.getByText('acceptance-note-3', { exact: true })).toBeVisible();
}

async function freshness(page: Page, title: string, write: () => Promise<void>): Promise<number> {
  await page.evaluate((title) => {
    const state = window as unknown as {
      __acceptanceFreshness?: { seenAt: number; timer: number };
    };
    state.__acceptanceFreshness = { seenAt: -1, timer: 0 };
    state.__acceptanceFreshness.timer = window.setInterval(() => {
      if (
        Array.from(document.querySelectorAll('.pane-projects h3.title')).some(
          (element) => element.textContent === title,
        )
      ) {
        state.__acceptanceFreshness!.seenAt = Date.now();
        clearInterval(state.__acceptanceFreshness!.timer);
      }
    }, 4);
  }, title);
  const beforeWrite = Date.now();
  await write();
  await page.waitForFunction(
    () =>
      (window as unknown as { __acceptanceFreshness?: { seenAt: number } }).__acceptanceFreshness!
        .seenAt >= 0,
    null,
    { timeout: 30_000 },
  );
  return page.evaluate(
    (before) =>
      (window as unknown as { __acceptanceFreshness: { seenAt: number } }).__acceptanceFreshness
        .seenAt - before,
    beforeWrite,
  );
}

test('terminal acceptance measurement run (all probe families)', async ({}, testInfo) => {
  const label = process.env.CONDASH_TERM_ACCEPTANCE_LABEL ?? 'run';
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('invalid acceptance label');
  const output = resolve(__dirname, 'acceptance-out', `${label}-${Date.now()}-${process.pid}`);
  await mkdir(output, { recursive: true });
  const record: Record<string, unknown> = {
    label,
    output,
    state: 'running',
    quantizationMs: 4,
    limitations: [
      'parsed-buffer signal, not compositor pixels',
      'delivered receipt precedes parsing; no independent PTY/main evidence',
      'correlated in-run samples; p95 descriptive',
      'Xvfb software graphics, warm OS cache',
      '250 ms perfVitals heartbeat keeps all recorder windows observable',
    ],
  };
  const structuralFailures: string[] = [];
  const resources: Record<string, unknown> = {};
  record.structuralFailures = structuralFailures;
  record.resources = resources;
  const checkpoint = () => writeFile(join(output, 'record.json'), JSON.stringify(record, null, 2));
  const requireGate = (condition: boolean, failure: string): void => {
    if (!condition) structuralFailures.push(failure);
  };
  let booted: Awaited<ReturnType<typeof bootApp>> | undefined;
  const sessions: string[] = [];
  const measured: Record<string, ProbeOutcome[]> = {};
  record.samples = measured;
  try {
    const launchStart = performance.now();
    booted = await bootApp({
      globalConfig: {
        layout: { terminal: true },
        terminal: {
          memory: { enabled: false, appScope: { enabled: false } },
        },
        dashboard: { enabled: false },
        autoSync: { enabled: false },
      },
      prepare: syntheticConception,
    });
    const { window: page, app } = booted;
    await page.waitForSelector('.pane-projects h3.title');
    record.launchThroughFirstProjectsObservationMs = performance.now() - launchStart;
    record.bootMetricScope =
      'before bootApp launch/fixture setup through first Projects observation; includes test transport, not exact first paint';
    await armTerminalTestSurfaces(page);
    const sinceIso = await startTelemetryHeartbeat(page, booted.conceptionDir);
    record.telemetryStart = sinceIso;
    record.identity = await recordIdentity(app, resolve(__dirname, '..'), label);
    const fixtures = await countFixture(booted.conceptionDir);
    const supportDir = join(booted.userDataDir, 'acceptance-support');
    await mkdir(supportDir);
    for (const name of ['user-AGENTS.md', 'repo-AGENTS.md', 'repo-README.md'])
      await writeFile(join(supportDir, name), `# ${name}\n\nSynthetic support document.\n`);
    record.fixtureCensus = {
      conception: fixtures,
      support: await countFixture(supportDir),
      ordinary: 60,
      scratch: 20,
      baseline: 8,
      total: fixtures.markdownFiles + 3,
    };
    expect(fixtures.markdownFiles).toBe(88);
    expect(fixtures.bytes).toBeLessThan(5 * 1024 * 1024);
    record.fixtureProfiles = {
      busy: { seed: 90210, scheduledRate: 16384 },
      receipt: { seed: 314159, scheduledRate: 16384, payloadBytes: SAMPLES * RECEIPT_BYTES },
      burst: {
        seed: 271828,
        scheduledRate: 131072,
        payloadBytes: BURST_BYTES,
        tokens: 64,
        shortLines: 100,
      },
      samples: SAMPLES,
      keyboardSamples: KEYBOARD_SAMPLES,
    };
    record.floorsStart = await measureTransportFloor(page, 30);
    const resource = async (phase: string, edge: 'before' | 'after'): Promise<void> => {
      const vitals = await page.evaluate(() => window.condash.perfVitals());
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
      resources[`${phase}-${edge}`] = {
        at: new Date().toISOString(),
        scope:
          'Electron-reported process aggregates; not calibrated host CPU or unique physical memory',
        vitals,
        metrics,
      };
      expect(vitals.recording).toBe(true);
      expect(vitals.writeFailed).toBe(false);
    };
    resources['boot-before'] = { scope: 'unavailable: Electron process not yet launched' };
    await resource('boot', 'after');
    const phase = async (name: string, body: () => Promise<void>): Promise<void> => {
      record.phase = name;
      await resource(name, 'before');
      await checkpoint();
      await body();
      await resource(name, 'after');
      await checkpoint();
    };
    const sample = async (name: string, outcome: ProbeOutcome, sid: string): Promise<void> => {
      (measured[name] ??= []).push(outcome);
      expect(outcome.timedOut, `${name} marker timeout`).toBe(false);
      expect(outcome.firstMs).toBeGreaterThanOrEqual(0);
      if (outcome.settledMs !== undefined)
        expect(outcome.settledMs).toBeGreaterThanOrEqual(outcome.firstMs);
      await settledGeometry(page, sid);
    };
    const echo = await spawn(page, ECHO);
    sessions.push(echo);
    await phase('idle', async () => {
      for (let index = 0; index < SAMPLES; index++)
        await sample(
          'idle',
          await measureEchoFirstFrame(page, echo, `P1${String(index).padStart(3, '0')}`),
          echo,
        );
    });
    await phase('keyboard', async () => {
      await page.locator('.terminal-host .xterm-screen').first().click();
      for (let index = 0; index < KEYBOARD_SAMPLES; index++)
        await sample(
          'keyboard',
          await measureKeyboardEcho(page, echo, `P8${String(index).padStart(3, '0')}`, (text) =>
            page.keyboard.type(text),
          ),
          echo,
        );
    });
    const other = await spawn(page, ECHO);
    sessions.push(other);
    await phase('switch', async () => {
      for (let index = 0; index < SAMPLES; index++) {
        await activate(page, other);
        await sample(
          'switch',
          await measureSettledSwitch(page, echo, `P2${String(index).padStart(3, '0')}`),
          echo,
        );
      }
    });
    const busy = await spawn(
      page,
      SUSTAIN,
      '--mode sustain --rate 16384 --budget 4194304 --seed 90210 --echo --hold',
      'SUSTAIN-READY',
    );
    sessions.push(busy);
    await page.evaluate((sid) => window.condash.termWrite(sid, 'GO'), busy);
    await phase('busy', async () => {
      const activeLoad: unknown[] = [];
      record.busyLoad = activeLoad;
      for (let index = 0; index < SAMPLES; index++) {
        const before = await deliveredPayload(page, busy);
        await waitForPayload(page, busy, before.payloadBytes + 4096);
        await activate(page, echo);
        await sample(
          'otherIdle',
          await measureEchoFirstFrame(page, echo, `P30${String(index).padStart(3, '0')}`),
          echo,
        );
        await activate(page, busy);
        await sample(
          'busySelf',
          await measureEchoFirstFrame(page, busy, `P31${String(index).padStart(3, '0')}`),
          busy,
        );
        const after = await deliveredPayload(page, busy);
        expect(after.done, 'busy load must remain active during every sample').toBe(false);
        activeLoad.push({
          index,
          beforeBytes: before.payloadBytes,
          afterBytes: after.payloadBytes,
        });
      }
    });
    // Observe the last loaded-case window before closing its session.
    record.busyTelemetryBeforeClose = await waitForPerfEvidence(
      booted.conceptionDir,
      (resources['busy-before'] as { at: string }).at,
      new Date().toISOString(),
      [busy],
    );
    await page.evaluate((sid) => window.condash.termClose(sid), busy);
    await phase('receipt', async () => {
      const sid = await spawn(
        page,
        SUSTAIN,
        `--mode sustain --rate 16384 --budget ${SAMPLES * RECEIPT_BYTES} --seed 314159 --hold`,
        'SUSTAIN-READY',
      );
      sessions.push(sid);
      await startPayload(page, sid, SAMPLES * RECEIPT_BYTES, RECEIPT_BYTES);
      let previous = 0;
      const receipts: unknown[] = [];
      record.receipts = receipts;
      for (let index = 1; index <= SAMPLES; index++) {
        const receipt = await waitForPayload(page, sid, index * RECEIPT_BYTES, index === SAMPLES);
        const arrival = receipt.timing?.marks[index - 1]?.elapsedMs;
        expect(arrival, 'receipt mark has an onTermData arrival timestamp').not.toBeNull();
        expect(typeof arrival).toBe('number');
        receipts.push({
          intervalMs: arrival! - previous,
          arrivalElapsedMs: arrival,
          payloadBytes: receipt.payloadBytes,
          mark: index * RECEIPT_BYTES,
        });
        previous = arrival!;
      }
      const receipt = await deliveredPayload(page, sid);
      expect(receipt.payloadBytes).toBe(SAMPLES * RECEIPT_BYTES);
      expect(receipt.scheduledBytes).toBe(receipt.payloadBytes);
      record.receiptPayload = receipt;
      await expect
        .poll(async () => (await registryCensus(page, sid, ['PAYLOAD-END'])).found.length)
        .toBe(1);
    });
    await phase('burst', async () => {
      const sid = await spawn(page, SUSTAIN, '--mode burst --seed 271828 --hold', 'SUSTAIN-READY');
      sessions.push(sid);
      const preparation = await prepareBurstRetention(page, sid, SCROLLBACK);
      record.burstPreparation = {
        intervention:
          'test-only mounted registry option; not product preference propagation or default retention',
        ...preparation,
      };
      const geometryBefore = preparation.prepared;
      const triggerStart = performance.now();
      await startPayload(page, sid, BURST_BYTES);
      const receipt = await waitForPayload(page, sid, BURST_BYTES, true);
      const triggerThroughReceiptMs = receipt.timing?.fullReceiptMs;
      expect(typeof triggerThroughReceiptMs).toBe('number');
      expect(receipt.timing?.observedPayloadBytes).toBe(BURST_BYTES);
      expect(receipt.timing?.completionMs).toBeGreaterThanOrEqual(triggerThroughReceiptMs!);
      expect(receipt.payloadBytes).toBe(BURST_BYTES);
      expect(receipt.scheduledBytes).toBe(BURST_BYTES);
      await expect
        .poll(async () => (await registryCensus(page, sid, ['PAYLOAD-END', 'DONE'])).found.length, {
          timeout: 15_000,
        })
        .toBe(2);
      const geometry = await settledGeometry(page, sid);
      const needles = Array.from(
        { length: 64 },
        (_, index) => `TKN-${String(index).padStart(3, '0')}`,
      );
      const census = await burstCensus(page, sid, needles);
      record.observerOverhead = await measureObserverOverhead(page, sid, needles);
      const stream = await transportStats(page, sid);
      // READY, BEGIN, END, DONE and one final cursor row are also retained.
      const wrappedPayloadRows = requiredWrappedRows(receipt.lineLengths, geometry.cols);
      const requiredRows = wrappedPayloadRows + 5;
      record.burst = {
        receipt,
        geometryBefore,
        geometry,
        wrappedPayloadRows,
        requiredRows,
        retainedCapacityRows: geometry.scrollback + geometry.rows,
        ledger: census.entries,
        stream,
        achievedPayloadBytesPerSecond: BURST_BYTES / (receipt.elapsedMs / 1000),
        triggerThroughReceiptMs,
        receiptTimingScope:
          'in-page trigger before GO to onTermData callback containing final normalized payload byte, before xterm parsing',
        triggerThroughEvidenceMs: performance.now() - triggerStart,
        evidenceTimingScope:
          'Node-side start before trigger evaluation through parsing, geometry, census and overhead collection',
        rendererReceived: census.entries.filter((entry) => entry.inRegistry).length,
      };
      requireGate(
        geometry.scrollback === SCROLLBACK,
        `mounted scrollback ${geometry.scrollback} does not match requested ${SCROLLBACK}`,
      );
      requireGate(
        requiredRows <= geometry.scrollback + geometry.rows,
        `burst needs ${requiredRows} wrapped/control rows, capacity ${geometry.scrollback + geometry.rows}`,
      );
      requireGate(
        geometry.bufferLines === requiredRows,
        `final fixture rows ${geometry.bufferLines} differ from accounted ${requiredRows}`,
      );
      requireGate(
        census.entries.every(
          (entry) => entry.inRegistry && entry.rendererCount === 1 && entry.deliveredCount === 1,
        ),
        'final renderer burst census must retain all 64 tokens exactly once, with delivered provenance',
      );
      await checkpoint();
    });
    await phase('burstIdle', async () => {
      const sid = await spawn(page, SUSTAIN, '--mode burst --seed 271828 --hold', 'SUSTAIN-READY');
      sessions.push(sid);
      await activate(page, echo);
      await startPayload(page, sid, BURST_BYTES);
      const attempts: unknown[] = [];
      record.burstIdleAttempts = attempts;
      for (let index = 1; index <= SAMPLES; index++) {
        const atMark = await waitForPayload(
          page,
          sid,
          Math.floor((BURST_BYTES * index) / (SAMPLES + 1)),
        );
        if (atMark.done || atMark.payloadBytes >= BURST_BYTES) {
          attempts.push({
            index,
            included: false,
            reason: 'load completed before ACK trigger',
            atMark,
          });
          requireGate(false, `burst idle ${index}: load completed before ACK`);
          break;
        }
        const outcome = await measureEchoFirstFrame(
          page,
          echo,
          `P32${String(index).padStart(3, '0')}`,
          10_000,
          sid,
        );
        const included = isLoadedAck(outcome);
        attempts.push({
          index,
          included,
          outcome,
          reason: included
            ? null
            : 'no positive incomplete delivered-stream progress during trigger-to-ACK interval',
        });
        if (!included) {
          requireGate(false, `burst idle ${index}: excluded invalid loaded interval`);
          continue;
        }
        await sample('burstIdle', outcome, echo);
      }
      requireGate(
        (measured.burstIdle?.length ?? 0) === SAMPLES,
        `burst idle population ${measured.burstIdle?.length ?? 0}/${SAMPLES}`,
      );
      record.burstIdleReceipt = await waitForPayload(page, sid, BURST_BYTES, true);
    });
    await phase('freshness', async () => {
      const times: number[] = [];
      record.freshness = times;
      for (let index = 0; index < SAMPLES; index++) {
        const slug = String(index + 1).padStart(3, '0');
        const title = `Acceptance probe ${slug} rev ${index}`;
        times.push(
          await freshness(page, title, () =>
            writeFile(
              join(
                booted!.conceptionDir,
                `projects/2026-10/2026-10-08-acceptance-${slug}/README.md`,
              ),
              `# ${title}\n\n**Status**: now\n**Kind**: project\n`,
            ),
          ),
        );
      }
    });
    await phase('knowledge', async () => {
      // Honest post-boot activation, timestamped before the action.
      const start = performance.now();
      await visibleKnowledge(page);
      record.postBootKnowledgeFirstActivationMs = performance.now() - start;
    });
    await phase('hiddenReturn', async () => {
      await activate(page, echo);
      await visibleKnowledge(page);
      for (let index = 0; index < SAMPLES; index++) {
        await sample(
          'hiddenReturn',
          await measureHiddenBandReturn(page, echo, `P6${String(index).padStart(3, '0')}`),
          echo,
        );
        await expect(page.getByText('acceptance-note-3', { exact: true })).toBeVisible();
      }
    });
    record.floorsEnd = await measureTransportFloor(page, 30);
    const untilIso = new Date().toISOString();
    const telemetry = await waitForPerfEvidence(booted.conceptionDir, sinceIso, untilIso, sessions);
    record.telemetry = telemetry;
    for (const [sid, counter] of Object.entries(telemetry.counters)) {
      requireGate(
        counter.activityWindows > 0 && counter.bytes > 0 && counter.batches > 0,
        `missing positive session telemetry: ${sid}`,
      );
      requireGate(counter.watchdogs === 0, `watchdogs for ${sid}: ${counter.watchdogs}`);
    }
    const floor = Math.max(
      (record.floorsStart as { emptyMedianMs: number }).emptyMedianMs,
      (record.floorsEnd as { emptyMedianMs: number }).emptyMedianMs,
    );
    const dist = (name: string, settled = false) =>
      summarize(measured[name].map((outcome) => (settled ? outcome.settledMs! : outcome.firstMs)));
    const checks = [
      checkThreshold('idle first-frame', dist('idle'), { medianBound: 400, p95Bound: 800 }),
      checkThreshold('other-idle under busy', dist('otherIdle'), {
        medianBound: 120,
        p95Bound: 250,
      }),
      checkThreshold('busy-self', dist('busySelf'), { medianBound: 400, p95Bound: 500 }),
      checkThreshold('settled switch', dist('switch', true), { medianBound: 1000, p95Bound: 2000 }),
      checkThreshold('Projects freshness', summarize(record.freshness as number[]), {
        medianBound: 700,
        p95Bound: 1000,
      }),
      checkThreshold('hidden return to visible parsed content', dist('hiddenReturn'), {
        medianBound: 250,
      }),
      checkThreshold('transport floor', summarize([floor]), { medianBound: 15 }),
    ];
    const validityFailures: string[] = [];
    for (const [name, median] of Object.entries({
      idle: dist('idle').median,
      busySelf: dist('busySelf').median,
      switch: dist('switch', true).median,
      freshness: summarize(record.freshness as number[]).median,
    })) {
      if (median < 5 * floor)
        validityFailures.push(`${name} median ${median} < 5 × floor ${floor}`);
    }
    record.fastArmFloorRatios = Object.fromEntries(
      ['otherIdle', 'burstIdle', 'hiddenReturn', 'keyboard'].map((name) => [
        name,
        measured[name]?.length ? dist(name).median / floor : null,
      ]),
    );
    record.distributions = Object.fromEntries(
      Object.keys(measured).map((name) => [
        name,
        {
          first: dist(name),
          settled: measured[name].every((sample) => sample.settledMs !== undefined)
            ? dist(name, true)
            : null,
        },
      ]),
    );
    (record.distributions as Record<string, unknown>).receipt = summarize(
      (record.receipts as { intervalMs: number }[]).map((receipt) => receipt.intervalMs),
    );
    record.checks = checks;
    record.validityFailures = validityFailures;
    Object.assign(
      record,
      classifyAcceptanceReport({
        ciFlag: process.env.CI ?? null,
        cpuAffinity: (record.identity as { cpuAffinity: string }).cpuAffinity,
        rendererAffinity: (record.identity as { rendererAffinity: string }).rendererAffinity,
        structuralFailures: structuralFailures.length,
        validityFailures: validityFailures.length,
        thresholdChecksPass: checks.every((check) => check.pass),
      }),
    );
    await checkpoint();
    console.log(
      `ACCEPTANCE RECORD ${join(output, 'record.json')}\n${JSON.stringify({ state: record.state, thresholdJudgmentEligible: record.thresholdJudgmentEligible, allDescriptiveChecksClear: record.allDescriptiveChecksClear, allPass: record.allPass, structuralFailures, validityFailures, checks, distributions: record.distributions }, null, 2)}`,
    );
    expect(structuralFailures, 'structural acceptance gates; no partial census exemption').toEqual(
      [],
    );
    // Numerical limits remain recorded judgments, not new CI timing assertions.
  } catch (error) {
    record.error =
      error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    if (record.state === 'running') record.state = 'incomplete-failed';
    await checkpoint();
    throw error;
  } finally {
    if (booted) {
      await cp(booted.conceptionDir, join(output, 'fixture'), { recursive: true });
      await cp(booted.userDataDir, join(output, 'user-data'), { recursive: true });
      await booted.window.screenshot({ path: join(output, 'final.png') }).catch(() => undefined);
      await disposeTerminalTestSurfaces(booted.window).catch(() => undefined);
      await booted.cleanup();
    }
    await testInfo.attach('acceptance-record', {
      path: join(output, 'record.json'),
      contentType: 'application/json',
    });
  }
});
