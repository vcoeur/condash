import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dashboardStatePath,
  emptyDashboardState,
  loadDashboardState,
  pruneDashboardState,
  saveDashboardState,
} from './state';
import type { DashboardState } from '../../shared/types';

function stateWith(eventCount: number): DashboardState {
  const events = Array.from({ length: eventCount }, (_, i) => ({ at: i, text: `e${i}` }));
  return {
    updatedAt: 100,
    history: events,
    roster: [{ sid: 't-1', cwd: '/work' }],
    tabs: [
      {
        sid: 't-1',
        title: 'build',
        subtitle: 'Building the thing',
        contextLines: ['ctx'],
        currentAction: 'compiling',
        state: 'idle',
        activity: 'implementing',
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
      tabs: [],
      roster: [],
      history: [],
    });
  });
});

describe('saveDashboardState', () => {
  it('creates the .condash/dashboard dir on a fresh conception and round-trips', async () => {
    // A fresh conception has no `.condash/dashboard/` — the dir is created
    // lazily on first save and scaffolded nowhere else. Deliberately do NOT
    // mkdir it here: without the save's own mkdir, `atomicWrite` throws ENOENT
    // and every persist silently fails (the bug this guards against). Note the
    // sibling load test mkdir's the dir itself, which is exactly what masked it.
    const dir = await mkdtemp(join(tmpdir(), 'condash-dash-save-'));
    await expect(saveDashboardState(dir, emptyDashboardState(7))).resolves.toBeUndefined();
    const loaded = await loadDashboardState(dir);
    expect(loaded?.updatedAt).toBe(7);
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
    // A pre-redesign persisted summary backfills its new fields on load.
    expect(loaded?.tabs[0]?.state).toBe('idle');
    expect(loaded?.tabs[0]?.activity).toBe('idle');
    expect(loaded?.tabs[0]?.subtitle).toBe('');
  });

  it('round-trips the redesign tab fields (subtitle, activity, provenance) when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'condash-dash-fields-'));
    await mkdir(join(dir, '.condash', 'dashboard'), { recursive: true });
    await writeFile(
      dashboardStatePath(dir),
      JSON.stringify({
        updatedAt: 5,
        history: [],
        roster: [],
        tabs: [
          {
            sid: 't-1',
            title: 'redesign',
            subtitle: 'Shipping the dashboard redesign',
            contextLines: [],
            currentAction: 'editing',
            state: 'working',
            activity: 'implementing',
            app: 'condash',
            worktree: 'dashboard-redesign',
            projects: [{ slug: 's', title: 'Redesign' }],
            updatedAt: 5,
            events: [],
          },
        ],
      }),
    );
    const loaded = await loadDashboardState(dir);
    const tab = loaded?.tabs[0];
    expect(tab?.subtitle).toBe('Shipping the dashboard redesign');
    expect(tab?.activity).toBe('implementing');
    expect(tab?.app).toBe('condash');
    expect(tab?.worktree).toBe('dashboard-redesign');
    expect(tab?.projects).toEqual([{ slug: 's', title: 'Redesign' }]);
  });
});
