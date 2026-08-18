import { describe, expect, it } from 'vitest';
import type { Project, Step, StepMarker, TimelineEntry } from '../../../shared/types';
import { groupByStatus, groupDone, lastDate, nextOpenStep, projectsTabGroups } from './data';

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
    parent: null,
    steps,
    stepCounts: { todo: 0, doing: 0, done: 0, blocked: 0, dropped: 0 },
    deliverables: [],
    deliverableCount: 0,
    closedAt: null,
    timeline: [],
  } as Project;
}

function projectAt(slug: string, status: string, path = `/p/${slug}`): Project {
  return {
    slug,
    path,
    title: slug,
    kind: 'project',
    status,
    apps: [],
    branch: null,
    base: null,
    parent: null,
    steps: [],
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

describe('projectsTabGroups — stable section order + identity (R2)', () => {
  it('emits groups in PROJECT_SECTION_ORDER, appending unknown only when non-empty', () => {
    const groups = projectsTabGroups(
      groupByStatus([projectAt('2026-05-01-a', 'now'), projectAt('2026-05-02-b', 'later')]),
    );
    expect(groups.map((g) => g.status)).toEqual(['now', 'review', 'later', 'backlog', 'done']);
  });

  it('reuses the prior Group object for a status whose membership is unchanged', () => {
    const now = projectAt('2026-05-01-a', 'now');
    const later = projectAt('2026-05-02-b', 'later');
    const first = projectsTabGroups(groupByStatus([now, later]));

    // A step toggle on the "now" project replaces only that object; "later" keeps
    // its reference, mirroring how the real mutate path rebuilds projects().
    const nowChanged = { ...now, steps: [step('x', 'done')] } as Project;
    const second = projectsTabGroups(groupByStatus([nowChanged, later]), first);

    const byStatus = (groups: ReturnType<typeof projectsTabGroups>, status: string) =>
      groups.find((g) => g.status === status)!;

    // Unchanged bucket → same object identity (no GroupBlock remount).
    expect(byStatus(second, 'later')).toBe(byStatus(first, 'later'));
    expect(byStatus(second, 'review')).toBe(byStatus(first, 'review'));
    // Changed bucket → a fresh object.
    expect(byStatus(second, 'now')).not.toBe(byStatus(first, 'now'));
  });

  it('rebuilds both source and destination groups when an item moves status', () => {
    const p = projectAt('2026-05-01-a', 'now');
    const other = projectAt('2026-05-02-b', 'later');
    const first = projectsTabGroups(groupByStatus([p, other]));
    const moved = { ...p, status: 'review' } as Project;
    const second = projectsTabGroups(groupByStatus([moved, other]), first);
    const byStatus = (groups: ReturnType<typeof projectsTabGroups>, status: string) =>
      groups.find((g) => g.status === status)!;
    expect(byStatus(second, 'now')).not.toBe(byStatus(first, 'now')); // lost the item
    expect(byStatus(second, 'review')).not.toBe(byStatus(first, 'review')); // gained it
    expect(byStatus(second, 'later')).toBe(byStatus(first, 'later')); // untouched
  });
});

describe('star flag ordering', () => {
  /** Done item with an explicit close date, so `groupDone` can bucket it. */
  function doneAt(slug: string, closedAt: string): Project {
    return { ...projectAt(slug, 'done'), closedAt } as Project;
  }

  it('floats starred items to the top of their status section', () => {
    const items = [
      projectAt('2026-05-01-old', 'now'),
      projectAt('2026-05-03-newest', 'now'),
      projectAt('2026-05-02-mid', 'now'),
    ];
    const starred = new Set(['2026-05-01-old']);
    expect(
      groupByStatus(items, starred)
        .get('now')!
        .map((p) => p.slug),
    ).toEqual(['2026-05-01-old', '2026-05-03-newest', '2026-05-02-mid']);
  });

  it('keeps slug-descending order among the starred and among the rest', () => {
    const items = [
      projectAt('2026-05-01-a', 'now'),
      projectAt('2026-05-02-b', 'now'),
      projectAt('2026-05-03-c', 'now'),
      projectAt('2026-05-04-d', 'now'),
    ];
    const starred = new Set(['2026-05-01-a', '2026-05-03-c']);
    expect(
      groupByStatus(items, starred)
        .get('now')!
        .map((p) => p.slug),
    ).toEqual(['2026-05-03-c', '2026-05-01-a', '2026-05-04-d', '2026-05-02-b']);
  });

  it('leaves ordering untouched when nothing is starred', () => {
    const items = [projectAt('2026-05-01-a', 'now'), projectAt('2026-05-02-b', 'now')];
    const withEmptySet = groupByStatus(items, new Set<string>())
      .get('now')!
      .map((p) => p.slug);
    expect(
      groupByStatus(items)
        .get('now')!
        .map((p) => p.slug),
    ).toEqual(withEmptySet);
    expect(withEmptySet).toEqual(['2026-05-02-b', '2026-05-01-a']);
  });

  it('does not leak a star across status sections', () => {
    const items = [projectAt('2026-05-01-a', 'now'), projectAt('2026-05-02-b', 'later')];
    const buckets = groupByStatus(items, new Set(['2026-05-01-a']));
    expect(buckets.get('now')!.map((p) => p.slug)).toEqual(['2026-05-01-a']);
    expect(buckets.get('later')!.map((p) => p.slug)).toEqual(['2026-05-02-b']);
  });

  it('applies inside the Done recent window and month subgroups too', () => {
    const done = [
      doneAt('2026-05-01-recent-new', '2026-05-20'),
      doneAt('2026-05-02-recent-old', '2026-05-18'),
      doneAt('2026-04-01-month-new', '2026-04-20'),
      doneAt('2026-04-02-month-old', '2026-04-10'),
    ];
    const grouping = groupDone(
      done,
      '2026-05-21',
      new Set(['2026-05-02-recent-old', '2026-04-02-month-old']),
    );
    // Recent window: the starred (older) item leads despite the date sort.
    expect(grouping.recent.map((p) => p.slug)).toEqual([
      '2026-05-02-recent-old',
      '2026-05-01-recent-new',
    ]);
    // Same rule one level down, inside the close-month subgroup.
    expect(grouping.byMonth[0].month).toBe('2026-04');
    expect(grouping.byMonth[0].projects.map((p) => p.slug)).toEqual([
      '2026-04-02-month-old',
      '2026-04-01-month-new',
    ]);
  });
});
