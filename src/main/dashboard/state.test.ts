import { describe, expect, it } from 'vitest';
import { emptyDashboardState, pruneDashboardState } from './state';
import type { DashboardState } from '../../shared/types';

function stateWith(eventCount: number): DashboardState {
  const events = Array.from({ length: eventCount }, (_, i) => ({ at: i, text: `e${i}` }));
  return {
    updatedAt: 100,
    overview: ['doing things'],
    history: events,
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
    expect(emptyDashboardState(42)).toEqual({ updatedAt: 42, overview: [], tabs: [], history: [] });
  });
});
