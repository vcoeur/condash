import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_CHANNELS } from '../../shared/ipc-channels';
import type { DashboardConfig, DashboardState, TabInfo } from '../../shared/types';
import type { OverviewResult, TabSummaryResult } from './summarizer';

// Mutable fixtures the mocks read, so each case can shape the engine's inputs.
const h = vi.hoisted(() => ({
  config: null as DashboardConfig | null,
  tabs: [] as TabInfo[],
  bytes: new Map<string, number>(),
  recent: '',
  summary: null as TabSummaryResult | null,
  overview: null as OverviewResult | null,
  // Every `dashboardState` payload the engine broadcasts, in order — lets a test
  // assert what actually reached the renderer (not just the in-memory state).
  pushed: [] as DashboardState[],
}));

// The engine broadcasts via getAllWindows().webContents.send. A single fake
// window records every `dashboardState` push so a test can assert the renderer
// saw the final post-cycle state even when persistence fails.
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => {
            if (channel === EVENT_CHANNELS.dashboardState) h.pushed.push(payload as DashboardState);
          },
        },
      },
    ],
  },
}));
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
  h.pushed = [];
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
    h.summary = {
      title: 'Build',
      contextLines: ['compiling'],
      currentAction: 'compiling',
      state: 'working',
    };
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

  it('marks the in-flight tab "summarizing", then clears the overlay when it rests', async () => {
    h.tabs = [{ sid: 'a', cwd: '/w', cmd: 'sh' }];
    h.bytes = new Map([['a', 12]]);
    h.recent = 'real transcript output';
    h.summary = {
      title: 'Build',
      contextLines: ['compiling'],
      currentAction: 'compiling',
      state: 'working',
    };
    h.overview = { overview: ['Tab a is compiling'], events: [] };
    await setDashboardConception(CONCEPTION);
    // While the LLM call is in flight the renderer must have seen the tab in
    // `summarizingSids` alongside the `summarizing` phase — that's the signal the
    // card badge reads to render "Summarizing" instead of its prior state.
    await vi.waitFor(() =>
      expect(
        h.pushed.some(
          (s) => s.engine?.phase === 'summarizing' && (s.summarizingSids ?? []).includes('a'),
        ),
      ).toBe(true),
    );
    // Once the cycle settles, the transient overlay is dropped so the card falls
    // back to its real state ('working').
    await vi.waitFor(() => {
      expect(getDashboardState()?.engine?.phase).toBe('waiting');
      expect(getDashboardState()?.summarizingSids).toEqual([]);
    });
  });

  it('still pushes the final state to the renderer when persistence fails', async () => {
    const { saveDashboardState } = await import('./state');
    vi.mocked(saveDashboardState).mockRejectedValue(new Error('ENOENT: state dir missing'));
    h.tabs = [{ sid: 'a', cwd: '/w', cmd: 'sh' }];
    h.bytes = new Map([['a', 12]]);
    h.recent = 'real transcript output';
    h.summary = {
      title: 'Build',
      contextLines: ['compiling'],
      currentAction: 'compiling',
      state: 'working',
    };
    h.overview = { overview: ['Tab a is compiling'], events: [] };
    await setDashboardConception(CONCEPTION);
    // The renderer must still receive the post-cycle state — summarized tab,
    // resting `waiting` phase — even though the save threw. The old order (save
    // then push) skipped the push on a throwing save, so every summary and the
    // phase reset never reached the pane (it stayed stuck on "summarizing").
    await vi.waitFor(() => {
      const last = h.pushed.at(-1);
      expect(last?.engine?.phase).toBe('waiting');
      expect(last?.tabs.map((tab) => tab.sid)).toEqual(['a']);
    });
  });
});
