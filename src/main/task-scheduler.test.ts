import { describe, expect, it } from 'vitest';
import type { TabInfo } from '../shared/types';
import {
  isTaskDue,
  resolveGate,
  resolveRunMode,
  resolveRunTimeout,
  selectUpdatedTabs,
} from './task-scheduler';

const DEFAULT_MS = 10 * 60_000;

describe('resolveRunTimeout', () => {
  it('uses the per-task timeout when set', () => {
    expect(resolveRunTimeout({ timeout: '1m' })).toBe(60_000);
    expect(resolveRunTimeout({ timeout: '30s' })).toBe(30_000);
    expect(resolveRunTimeout({ timeout: '1h' })).toBe(3_600_000);
  });

  it('falls back to the 10m default when absent or unparseable', () => {
    expect(resolveRunTimeout(undefined)).toBe(DEFAULT_MS);
    expect(resolveRunTimeout({})).toBe(DEFAULT_MS);
    expect(resolveRunTimeout({ timeout: '' })).toBe(DEFAULT_MS);
    expect(resolveRunTimeout({ timeout: 'soon' })).toBe(DEFAULT_MS);
  });
});

describe('resolveRunMode', () => {
  it('uses oneshot only when explicitly set', () => {
    expect(resolveRunMode({ runMode: 'oneshot' })).toBe('oneshot');
  });

  it('defaults to interactive when absent or any other value', () => {
    expect(resolveRunMode(undefined)).toBe('interactive');
    expect(resolveRunMode({})).toBe('interactive');
    expect(resolveRunMode({ runMode: 'interactive' })).toBe('interactive');
  });
});

describe('resolveGate', () => {
  it('gates only when explicitly opted in', () => {
    expect(resolveGate({ gateOnUpdatedTabs: true })).toBe(true);
  });

  it('defaults to no gate when absent or false (runs every interval)', () => {
    expect(resolveGate(undefined)).toBe(false);
    expect(resolveGate({})).toBe(false);
    expect(resolveGate({ gateOnUpdatedTabs: false })).toBe(false);
  });
});

describe('isTaskDue', () => {
  it('is due once at least the cadence has elapsed since the last check', () => {
    expect(isTaskDue(10_000, 0, 5_000)).toBe(true);
    expect(isTaskDue(5_000, 0, 5_000)).toBe(true); // exactly the cadence
  });

  it('is not due before the cadence has elapsed', () => {
    expect(isTaskDue(4_999, 0, 5_000)).toBe(false);
    expect(isTaskDue(10_000, 8_000, 5_000)).toBe(false);
  });

  it('a never-checked task (lastCheckedAt 0) is due on the first non-trivial now', () => {
    expect(isTaskDue(20_000, 0, 20_000)).toBe(true);
  });
});

describe('selectUpdatedTabs', () => {
  const tab = (sid: string): TabInfo => ({ sid, cwd: `/w/${sid}` });

  it('returns every tab on the first run (empty previous snapshot)', () => {
    const tabs = [tab('a'), tab('b')];
    const current = new Map([
      ['a', 10],
      ['b', 20],
    ]);
    expect(selectUpdatedTabs(tabs, current, new Map()).map((t) => t.sid)).toEqual(['a', 'b']);
  });

  it('returns only tabs whose byte count moved since the previous snapshot', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    const current = new Map([
      ['a', 10],
      ['b', 25],
      ['c', 30],
    ]);
    const previous = new Map([
      ['a', 10], // unchanged
      ['b', 20], // grew
      ['c', 30], // unchanged
    ]);
    expect(selectUpdatedTabs(tabs, current, previous).map((t) => t.sid)).toEqual(['b']);
  });

  it('treats a newly-opened tab (absent from previous) as updated', () => {
    const tabs = [tab('a'), tab('new')];
    const current = new Map([
      ['a', 10],
      ['new', 5],
    ]);
    const previous = new Map([['a', 10]]);
    expect(selectUpdatedTabs(tabs, current, previous).map((t) => t.sid)).toEqual(['new']);
  });

  it('is empty when nothing changed', () => {
    const tabs = [tab('a')];
    const counts = new Map([['a', 10]]);
    expect(selectUpdatedTabs(tabs, counts, new Map(counts))).toEqual([]);
  });
});
