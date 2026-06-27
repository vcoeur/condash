import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dashboardStatePath,
  emptyDashboardState,
  loadDashboardState,
  pruneDashboardState,
} from './state';
import type { DashboardState } from '../../shared/types';

function stateWith(eventCount: number): DashboardState {
  const events = Array.from({ length: eventCount }, (_, i) => ({ at: i, text: `e${i}` }));
  return {
    updatedAt: 100,
    overview: ['doing things'],
    history: events,
    roster: [{ sid: 't-1', cwd: '/work' }],
    tabs: [
      {
        sid: 't-1',
        title: 'build',
        contextLines: ['ctx'],
        currentAction: 'compiling',
        updatedAt: 100,
        events,
      },
    ],
  };
}

describe('pruneDashboardState', () => {
  it('keeps the most recent N events globally and per tab', () => {
    const pruned = pruneDashboardState(stateWith(10), 3);
    expect(pruned.history.map((e) => e.text)).toEqual(['e7', 'e8', 'e9']);
    expect(pruned.tabs[0].events.map((e) => e.text)).toEqual(['e7', 'e8', 'e9']);
  });

  it('leaves arrays under the limit untouched', () => {
    const pruned = pruneDashboardState(stateWith(2), 5);
    expect(pruned.history).toHaveLength(2);
    expect(pruned.tabs[0].events).toHaveLength(2);
  });

  it('drops everything when the limit is zero', () => {
    const pruned = pruneDashboardState(stateWith(4), 0);
    expect(pruned.history).toEqual([]);
    expect(pruned.tabs[0].events).toEqual([]);
  });
});

describe('emptyDashboardState', () => {
  it('produces an empty state stamped with the given time', () => {
    expect(emptyDashboardState(42)).toEqual({
      updatedAt: 42,
      overview: [],
      tabs: [],
      roster: [],
      history: [],
    });
  });
});

describe('loadDashboardState', () => {
  it('keeps summarized tabs but resets the live roster to empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'condash-dash-state-'));
    const path = dashboardStatePath(dir);
    await mkdir(join(dir, '.condash', 'dashboard'), { recursive: true });
    // A persisted roster is stale the moment the app reopens, so load must drop
    // it; the summarized tabs (real history) must survive.
    await writeFile(
      path,
      JSON.stringify({
        updatedAt: 5,
        overview: ['busy'],
        history: [],
        roster: [{ sid: 'gone', cwd: '/old' }],
        // Stale liveness from the previous run — must be dropped on load.
        engine: { phase: 'summarizing', nextRunAt: 999, lastRunAt: 5 },
        tabs: [
          {
            sid: 't-1',
            title: 'build',
            contextLines: [],
            currentAction: '',
            updatedAt: 5,
            events: [],
          },
        ],
      }),
    );
    const loaded = await loadDashboardState(dir);
    expect(loaded?.roster).toEqual([]);
    expect(loaded?.engine).toBeUndefined();
    expect(loaded?.tabs.map((tab) => tab.sid)).toEqual(['t-1']);
  });
});
