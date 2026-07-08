/**
 * E3 lifecycle test for the dashboard engine: a tick whose LLM round-trips
 * straddle a conception switch/teardown must abort at the generation guard
 * before it overwrites the (already reset) module state or persists the old
 * tree's cards. `summarizeTab` is a controllable gate held open across the
 * switch; `saveDashboardState` (only reached after the guard) is the observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardConfig } from '../../shared/types';

const h = vi.hoisted(() => {
  let resolveSummarize: ((v: unknown) => void) | null = null;
  let gate: Promise<unknown> = Promise.resolve(null);
  return {
    summarizeTab: vi.fn(() => gate),
    writeCard: vi.fn(async () => ({ title: 'T', subtitle: 'S' })),
    deriveProvenance: vi.fn(async () => ({})),
    saveDashboardState: vi.fn(async () => {}),
    loadDashboardState: vi.fn(async () => null),
    armGate: () => {
      gate = new Promise((res) => {
        resolveSummarize = res;
      });
    },
    releaseSummarize: (v: unknown) => resolveSummarize?.(v),
    resetGate: () => {
      gate = Promise.resolve(null);
      resolveSummarize = null;
    },
  };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../terminals', () => ({
  dashboardRoster: () => [{ sid: 's1', cwd: '/w', cmd: 'claude' }],
  tabsBytes: () => new Map([['s1', 100]]),
  tabRecentText: () => 'recent output line',
}));
vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  const config: DashboardConfig = {
    ...actual.DASHBOARD_DEFAULTS,
    enabled: true,
    apiKey: 'k',
    gateOnActivity: false,
    intervalSec: 30,
  };
  return { ...actual, readDashboardConfig: vi.fn(async () => config) };
});
vi.mock('./summarizer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./summarizer')>();
  return { ...actual, summarizeTab: h.summarizeTab, writeCard: h.writeCard };
});
vi.mock('./provenance', () => ({ deriveProvenance: h.deriveProvenance }));
vi.mock('./state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state')>();
  return {
    ...actual,
    loadDashboardState: h.loadDashboardState,
    saveDashboardState: h.saveDashboardState,
  };
});

import { setDashboardConception } from './engine';

const TREE_A = '/tmp/condash-engine-tree-a';
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const summary = {
  title: 'old-tree card',
  contextLines: [],
  currentAction: 'doing',
  state: 'working' as const,
  activity: 'implementing' as const,
};

beforeEach(() => {
  h.summarizeTab.mockClear();
  h.saveDashboardState.mockClear();
  h.resetGate();
});

afterEach(async () => {
  await setDashboardConception(null);
});

describe('dashboard engine lifecycle (E3)', () => {
  it('harness sanity: a normal cycle reaches saveDashboardState', async () => {
    // Gate returns null → summarizeTab yields no card, but the tick still
    // completes and persists the resting state.
    await setDashboardConception(TREE_A);
    await vi.waitFor(() => expect(h.saveDashboardState).toHaveBeenCalled());
  });

  it('a teardown mid-cycle aborts before persisting old-tree state', async () => {
    h.armGate();
    await setDashboardConception(TREE_A); // fires an immediate tick that gates
    await vi.waitFor(() => expect(h.summarizeTab).toHaveBeenCalledTimes(1));
    // Tear down mid-cycle: resets state + bumps the generation the tick captured.
    await setDashboardConception(null);
    h.saveDashboardState.mockClear();
    // Release the old cycle's summarize; it resumes AFTER teardown and must bail
    // at the generation guard before it clobbers state or persists.
    h.releaseSummarize(summary);
    await flush();
    expect(h.saveDashboardState).not.toHaveBeenCalled();
  });
});
