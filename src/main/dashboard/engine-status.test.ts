import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardConfig, TabInfo } from '../../shared/types';
import type { OverviewResult, TabSummaryResult } from './summarizer';

// Mutable fixtures the mocks read, so each case can shape the engine's inputs.
const h = vi.hoisted(() => ({
  config: null as DashboardConfig | null,
  tabs: [] as TabInfo[],
  bytes: new Map<string, number>(),
  recent: '',
  summary: null as TabSummaryResult | null,
  overview: null as OverviewResult | null,
}));

// The engine imports electron + broadcasts via getAllWindows(); stub to no-op.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  return { ...actual, readDashboardConfig: vi.fn(async () => h.config) };
});
vi.mock('../terminals', () => ({
  tabsContext: () => h.tabs,
  tabsBytes: () => h.bytes,
  tabRecentText: () => h.recent,
}));
vi.mock('./summarizer', () => ({
  clearSummarizerError: () => {},
  getSummarizerError: () => null,
  makeEvent: (text: string, at: number) => ({ at, text }),
  summarizeTab: vi.fn(async () => h.summary),
  synthesizeOverview: vi.fn(async () => h.overview),
}));
vi.mock('./state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state')>();
  return { ...actual, saveDashboardState: vi.fn(async () => {}) };
});

import { getDashboardState, setDashboardConception } from './engine';

const CONCEPTION = '/tmp/condash-engine-status-test';

function baseConfig(): DashboardConfig {
  return {
    enabled: true,
    provider: 'deepseek',
    apiKey: 'k',
    model: 'm',
    intervalSec: 30,
    gateOnActivity: true,
    historyLimit: 50,
  };
}

beforeEach(() => {
  h.config = baseConfig();
  h.tabs = [];
  h.bytes = new Map();
  h.recent = '';
  h.summary = null;
  h.overview = null;
});

afterEach(async () => {
  await setDashboardConception(null);
  vi.clearAllMocks();
});

describe('dashboard engine status', () => {
  it('reports no-api-key when enabled without a key', async () => {
    h.config = { ...baseConfig(), apiKey: undefined };
    h.tabs = [{ sid: 'a', cwd: '/w' }];
    await setDashboardConception(CONCEPTION);
    // setDashboardConception fires one immediate tick; poll until it lands.
    await vi.waitFor(() => expect(getDashboardState()?.engine?.phase).toBe('no-api-key'));
  });

  it('reports idle when keyed but no tabs are open', async () => {
    h.tabs = [];
    await setDashboardConception(CONCEPTION);
    await vi.waitFor(() => expect(getDashboardState()?.engine?.phase).toBe('idle'));
    // No cycle ran (nothing to summarize), so last-run stays unset.
    expect(getDashboardState()?.engine?.lastRunAt).toBe(0);
  });

  it('summarizes a changed tab, then rests in waiting with a future next-run', async () => {
    h.tabs = [{ sid: 'a', cwd: '/w', cmd: 'sh' }];
    h.bytes = new Map([['a', 12]]);
    h.recent = 'real transcript output';
    h.summary = { title: 'Build', contextLines: ['compiling'], currentAction: 'compiling' };
    h.overview = { overview: ['Tab a is compiling'], events: [] };
    await setDashboardConception(CONCEPTION);
    await vi.waitFor(() => {
      const status = getDashboardState()?.engine;
      expect(status?.phase).toBe('waiting');
      expect(status?.lastRunAt).toBeGreaterThan(0);
      expect(status?.nextRunAt).toBeGreaterThan(status!.lastRunAt);
    });
    // The tab was actually summarized this cycle.
    expect(getDashboardState()?.tabs.map((tab) => tab.sid)).toEqual(['a']);
  });
});
