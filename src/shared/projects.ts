/**
 * Pure helpers for ranking projects by status and counting step markers.
 * Both bits used to be duplicated across main, CLI, and renderer; the only
 * thing that varied was whether a particular caller had a `Project` already
 * or only its `status` string.
 */
import { KNOWN_STATUSES, type Step, type StepCounts, type StepMarker } from './types';

/**
 * Index of `status` in `KNOWN_STATUSES`, with unknown statuses sorted last.
 * Mirrors how the on-screen Projects tab and the CLI both display "now"
 * before "review" before "later" before "backlog" before "done".
 */
export function statusOrder(status: string): number {
  const idx = (KNOWN_STATUSES as readonly string[]).indexOf(status);
  return idx === -1 ? KNOWN_STATUSES.length : idx;
}

/** Tally `[ ] / [~] / [x] / [-]` markers across a step list. */
export function countSteps(steps: readonly Step[]): StepCounts {
  const counts: StepCounts = { todo: 0, doing: 0, done: 0, dropped: 0 };
  for (const step of steps) {
    const marker: StepMarker = step.marker;
    if (marker === ' ') counts.todo++;
    else if (marker === '~') counts.doing++;
    else if (marker === 'x') counts.done++;
    else if (marker === '-') counts.dropped++;
  }
  return counts;
}
