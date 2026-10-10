import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  armTerminalTestSurfaces,
  classifyAcceptanceReport,
  deliveredPayload,
  disposeTerminalTestSurfaces,
  isLoadedAck,
  perfCoverage,
  requiredWrappedRows,
  startPayload,
} from './fixtures/terminal-acceptance';
import { summarize } from './fixtures/acceptance-stats';

describe('acceptance report eligibility', () => {
  const clear = {
    ciFlag: '1',
    cpuAffinity: '0-1',
    rendererAffinity: '0-1',
    structuralFailures: 0,
    validityFailures: 0,
    thresholdChecksPass: true,
  };
  it.each([
    { ciFlag: null, cpuAffinity: '0-7', rendererAffinity: '0-7' },
    { ciFlag: null, cpuAffinity: '0-1', rendererAffinity: '0-1' },
    { ciFlag: 'true', cpuAffinity: '0-1', rendererAffinity: '0-1' },
    { ciFlag: '1', cpuAffinity: '0-7', rendererAffinity: '0-1' },
    { ciFlag: '1', cpuAffinity: '0-1', rendererAffinity: '0-7' },
  ])('keeps an ineligible clear fixture descriptive: %j', (identity) => {
    expect(classifyAcceptanceReport({ ...clear, ...identity })).toEqual({
      thresholdJudgmentEligible: false,
      allDescriptiveChecksClear: true,
      allPass: false,
      state: 'complete-descriptive-clear',
    });
  });
  it('distinguishes eligible acceptance from descriptive clearance', () => {
    expect(classifyAcceptanceReport(clear)).toEqual({
      thresholdJudgmentEligible: true,
      allDescriptiveChecksClear: true,
      allPass: true,
      state: 'complete-acceptance-pass',
    });
  });
  it.each([{ structuralFailures: 1 }, { validityFailures: 1 }, { thresholdChecksPass: false }])(
    'keeps each failed gate failed in both scopes: %j',
    (failure) => {
      expect(classifyAcceptanceReport({ ...clear, ...failure })).toMatchObject({
        allDescriptiveChecksClear: false,
        allPass: false,
        state: 'complete-acceptance-failed-gates',
      });
      expect(classifyAcceptanceReport({ ...clear, ...failure, ciFlag: null })).toMatchObject({
        thresholdJudgmentEligible: false,
        allDescriptiveChecksClear: false,
        allPass: false,
        state: 'complete-descriptive-failed-checks',
      });
    },
  );
});

describe('acceptance evidence arithmetic', () => {
  it('rejects a burst population other than the pinned 64 tokens', () => {
    const result = spawnSync(process.execPath, [
      resolve(__dirname, 'fixtures/sustained-output-fixture.mjs'),
      '--mode',
      'burst',
      '--tokens',
      '63',
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout.toString()).toContain('exactly 64');
  });
  it('counts wrapped rows, not logical lines or row-times-column bytes', () => {
    expect(requiredWrappedRows({ 1023: 3840, 96: 100 }, 180)).toBe(23140);
    expect(requiredWrappedRows({ 1023: 3840, 96: 100 }, 1023)).toBe(3940);
    expect(() => requiredWrappedRows({ 96: 1 }, 0)).toThrow();
  });
  it('requires records covering both boundaries and every intervening interval', () => {
    const record = (t: number, windowMs: number) => ({
      schema: 4,
      t: new Date(t).toISOString(),
      windowMs,
      sessions: {},
    });
    expect(perfCoverage([], 1000, 2000).covered).toBe(false);
    expect(perfCoverage([record(1500, 1000)], 1000, 2000).covered).toBe(false);
    expect(perfCoverage([record(1500, 1000), record(2500, 999)], 1000, 2000).covered).toBe(false);
    expect(perfCoverage([record(1500, 1000), record(2500, 1000)], 1000, 2000).covered).toBe(true);
  });
  it('reports descriptive statistics for the full sample population', () => {
    expect(summarize([1, 2, 3, 4])).toMatchObject({ iqrLow: 1, iqrHigh: 3 });
    expect(summarize(Array.from({ length: 30 }, (_, index) => index + 1))).toMatchObject({
      n: 30,
      median: 15.5,
      min: 1,
      max: 30,
      p95: 29,
    });
    expect(() => summarize([])).toThrow();
  });
});

it('timestamps normalized receipt in the delivery callback across framing chunks', async () => {
  let deliver: (message: { id: string; data: string }) => void = () => undefined;
  const unsubscribe = vi.fn();
  const state = {
    document: { readyState: 'complete', body: { setAttribute: vi.fn() } },
    condash: {
      onTermData: (callback: typeof deliver) => {
        deliver = callback;
        return unsubscribe;
      },
      termWrite: vi.fn(async () => undefined),
    },
  };
  const page = {
    addInitScript: async () => undefined,
    evaluate: async (body: (argument: unknown) => unknown, argument?: unknown) => body(argument),
  } as unknown as Page;
  vi.stubGlobal('window', state);
  try {
    await armTerminalTestSurfaces(page);
    await startPayload(page, 'fixture', 9, 4);
    deliver({ id: 'fixture', data: 'PAYLOAD-BE' });
    deliver({ id: 'fixture', data: 'GIN\r\nabc\r\nACK P123\r\n12' });
    expect((await deliveredPayload(page, 'fixture')).timing?.fullReceiptMs).toBeNull();
    deliver({ id: 'fixture', data: '34\r\nPAYLOAD-' });
    const full = await deliveredPayload(page, 'fixture');
    expect(full.payloadBytes).toBe(9);
    expect(full.timing?.observedPayloadBytes).toBe(9);
    expect(typeof full.timing?.fullReceiptMs).toBe('number');
    expect(full.timing?.completionMs).toBeNull();
    deliver({ id: 'fixture', data: 'END 9 12\r\nDONE\r\n' });
    const completed = await deliveredPayload(page, 'fixture');
    expect(completed.done).toBe(true);
    expect(completed.timing?.completionMs).toBeGreaterThanOrEqual(completed.timing!.fullReceiptMs!);
    expect(completed.timing?.marks.every((mark) => typeof mark.elapsedMs === 'number')).toBe(true);
    await disposeTerminalTestSurfaces(page);
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('does not label cumulative or completed output as active load around an ACK', () => {
  const outcome = {
    firstMs: 16,
    timedOut: false,
    stage: 'first-frame' as const,
    load: {
      budget: 100,
      beforePayloadBytes: 50,
      atAckPayloadBytes: 60,
      beforeDeliveredBytes: 70,
      atAckDeliveredBytes: 80,
      beforeDone: false,
      atAckDone: false,
    },
  };
  expect(isLoadedAck(outcome)).toBe(true);
  expect(isLoadedAck({ ...outcome, load: { ...outcome.load, atAckDeliveredBytes: 70 } })).toBe(
    false,
  );
  expect(isLoadedAck({ ...outcome, load: { ...outcome.load, atAckPayloadBytes: 50 } })).toBe(true);
  expect(isLoadedAck({ ...outcome, load: { ...outcome.load, atAckPayloadBytes: 100 } })).toBe(
    false,
  );
  expect(isLoadedAck({ ...outcome, load: { ...outcome.load, atAckDone: true } })).toBe(false);
});

it('finite payloads are byte-exact and seeded comparisons are identical', async () => {
  const generate = () =>
    new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, [
        resolve(__dirname, 'fixtures/sustained-output-fixture.mjs'),
        '--rate',
        '1048576',
        '--budget',
        '8192',
        '--tokens',
        '8',
        '--lineBytes',
        '511',
        '--seed',
        '424242',
      ]);
      let text = '';
      const deadline = setTimeout(() => {
        child.kill();
        reject(new Error('fixture completion deadline'));
      }, 5000);
      child.stdout.on('data', (data) => {
        text += data.toString();
        if (!text.includes('PAYLOAD-END ')) return;
        clearTimeout(deadline);
        child.kill();
        const match = text.match(/PAYLOAD-BEGIN\n([\s\S]*)PAYLOAD-END (\d+) (\d+)\n/);
        if (!match) {
          reject(new Error('missing framing'));
          return;
        }
        expect(match[1].length).toBe(8192);
        expect(Number(match[2])).toBe(8192);
        expect((match[1].match(/PROBE TKN-\d{3}/g) ?? []).length).toBe(8);
        resolveOutput(match[1]);
      });
      child.on('error', reject);
    });
  expect(await generate()).toBe(await generate());
});

it('echo completion survives input chunk boundaries without premature ACKs', async () => {
  await new Promise<void>((resolveDone, reject) => {
    const child = spawn(process.execPath, [resolve(__dirname, 'fixtures/echo-probe-tui.mjs')]);
    let text = '';
    let ready = false;
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error('echo completion deadline'));
    }, 5000);
    child.stdout.on('data', (data) => {
      text += data.toString();
      if (!ready && text.includes('READY')) {
        ready = true;
        child.stdin.write('P12');
        child.stdin.write('345 ');
        child.stdin.write('F');
      }
      if (!text.includes('FROZEN')) return;
      clearTimeout(deadline);
      child.kill();
      expect(text).toContain('ACK P12345 ');
      expect(text).not.toMatch(/ACK P12\s/);
      resolveDone();
    });
    child.on('error', reject);
  });
});
