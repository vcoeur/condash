/**
 * Pure helpers for ranking projects by status and counting step markers.
 * Both bits used to be duplicated across main, CLI, and renderer; the only
 * thing that varied was whether a particular caller had a `Project` already
 * or only its `status` string.
 */
import { KNOWN_STATUSES, type Step, type StepCounts, type StepMarker } from './types';

/**
 * Index of `status` in `KNOWN_STATUSES`, with unknown statuses sorted last.
 * Mirrors how the on-screen Projects pane and the CLI both display "now"
 * before "review" before "later" before "backlog" before "done".
 */
export function statusOrder(status: string): number {
  const idx = (KNOWN_STATUSES as readonly string[]).indexOf(status);
  return idx === -1 ? KNOWN_STATUSES.length : idx;
}

/** Tally `[ ] / [~] / [x] / [!] / [-]` markers in the README's `## Steps`
 * section only — milestone count. Entries living under `## Step details`,
 * `## Notes`, or any other section are tracked by the parser for editing
 * purposes but excluded from the card-face "N/M steps" tally, which is
 * meant to reflect just the milestones. Case-insensitive on the section
 * name; multiple `## Steps` headings (rare but legal) all contribute. */
export function countSteps(steps: readonly Step[]): StepCounts {
  const counts: StepCounts = { todo: 0, doing: 0, done: 0, blocked: 0, dropped: 0 };
  for (const step of steps) {
    if (step.section.trim().toLowerCase() !== 'steps') continue;
    const marker: StepMarker = step.marker;
    if (marker === ' ') counts.todo++;
    else if (marker === '~') counts.doing++;
    else if (marker === 'x') counts.done++;
    else if (marker === '!') counts.blocked++;
    else if (marker === '-') counts.dropped++;
  }
  return counts;
}
