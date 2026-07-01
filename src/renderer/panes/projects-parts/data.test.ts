import { describe, expect, it } from 'vitest';
import type { Project, Step, StepMarker, TimelineEntry } from '../../../shared/types';
import { lastDate, nextOpenStep } from './data';

function step(marker: StepMarker, text: string, lineIndex = 0): Step {
  return { lineIndex, marker, text, section: 'Steps' };
}

function project(steps: Step[]): Project {
  return {
    slug: '2026-05-28-x',
    path: '/p',
    title: 'x',
    kind: 'project',
    status: 'now',
    apps: [],
    branch: null,
    base: null,
    steps,
    stepCounts: { todo: 0, doing: 0, done: 0, blocked: 0, dropped: 0 },
    deliverables: [],
    deliverableCount: 0,
    closedAt: null,
    timeline: [],
  } as Project;
}

describe('nextOpenStep', () => {
  it('returns the first todo step when nothing has started', () => {
    const a = step(' ', 'a', 0);
    expect(nextOpenStep(project([a, step(' ', 'b', 1)]))?.text).toBe('a');
  });

  it('skips past done [x] steps', () => {
    expect(
      nextOpenStep(project([step('x', 'a', 0), step('~', 'b', 1), step(' ', 'c', 2)]))?.text,
    ).toBe('b');
  });

  it('skips past dropped [-] steps so the in-progress step surfaces instead', () => {
    // Repro from vcoeur/condash#247: in-progress [~] step C must surface,
    // not the earlier abandoned [-] step B.
    const steps = [
      step('x', 'A', 0),
      step('-', 'B', 1),
      step('~', 'C', 2),
      step('-', 'D', 3),
      step(' ', 'E', 4),
    ];
    expect(nextOpenStep(project(steps))?.text).toBe('C');
  });

  it('returns undefined when every step is either done or dropped', () => {
    expect(
      nextOpenStep(project([step('x', 'a', 0), step('-', 'b', 1), step('x', 'c', 2)])),
    ).toBeUndefined();
  });

  it('still surfaces a blocked [!] step', () => {
    expect(nextOpenStep(project([step('-', 'a', 0), step('!', 'b', 1)]))?.text).toBe('b');
  });
});

describe('lastDate (timeline projection)', () => {
  const withDates = (over: Partial<Project>): Project => ({ ...project([]), ...over });
  const entry = (date: string): TimelineEntry => ({ date, text: 'x' });

  it('prefers the precomputed lastActivity scalar (resident list row)', () => {
    // The row carries lastActivity but an emptied timeline — the card still
    // shows the right date without holding the full timeline[].
    expect(lastDate(withDates({ lastActivity: '2026-06-30', timeline: [] }))).toBe('2026-06-30');
  });

  it('falls back to scanning timeline for a full project without the scalar', () => {
    expect(lastDate(withDates({ timeline: [entry('2026-06-01'), entry('2026-06-10')] }))).toBe(
      '2026-06-10',
    );
  });

  it('falls back to the slug date when there is no timeline at all', () => {
    expect(lastDate(withDates({ slug: '2026-05-28-x', timeline: [] }))).toBe('2026-05-28');
  });
});
