import { describe, expect, it } from 'vitest';
import type { Project } from '../shared/types';
import {
  BURST_DISTINCT_SLUGS,
  buildNeedles,
  pickSuggestion,
  scoreWindow,
  suggestProjectForText,
} from './tab-mentions';

/** A Project with only the fields the needle builder reads. */
function project(slug: string, status: string, branch: string | null = null): Project {
  return {
    slug,
    path: `/c/projects/${slug.slice(0, 7)}/${slug}/README.md`,
    title: slug,
    kind: 'project',
    status,
    apps: [],
    branch,
    base: null,
    parent: null,
    steps: [],
    stepCounts: { total: 0, done: 0 },
    deliverables: [],
    deliverableCount: 0,
    closedAt: null,
    timeline: [],
    lastActivity: null,
  } as unknown as Project;
}

const ALPHA = '2026-08-21-terminal-tab-project-links';
const BETA = '2026-08-25-action-auto-link-tab';

describe('buildNeedles', () => {
  it('ignores done projects — the bulk of the tree and of the noise', () => {
    const needles = buildNeedles([project(ALPHA, 'done'), project(BETA, 'now')]);
    expect(needles.every((n) => n.slug === BETA)).toBe(true);
  });

  it('takes every non-done status, not only now', () => {
    const needles = buildNeedles([
      project(ALPHA, 'review'),
      project(BETA, 'backlog'),
      project('2026-08-01-c', 'later'),
    ]);
    expect(new Set(needles.map((n) => n.slug)).size).toBe(3);
  });

  it('emits the dated slug and the short slug, longest first', () => {
    const needles = buildNeedles([project(ALPHA, 'now')]);
    expect(needles.map((n) => n.text)).toEqual([ALPHA, 'terminal-tab-project-links']);
  });

  it('does not double-count a branch that equals the short slug', () => {
    // The common case: `worktree setup` names the branch after the work, so
    // without the per-project dedupe the same text would score twice.
    const needles = buildNeedles([project(ALPHA, 'now', 'terminal-tab-project-links')]);
    expect(needles.filter((n) => n.text === 'terminal-tab-project-links')).toHaveLength(1);
  });

  it('keeps a branch that differs from the slug', () => {
    const needles = buildNeedles([project(ALPHA, 'now', 'feat/tab-links')]);
    expect(needles.map((n) => n.text)).toContain('feat/tab-links');
  });

  it('drops a long-lived branch, which identifies no single project', () => {
    const needles = buildNeedles([project(ALPHA, 'now', 'main')], ['main']);
    expect(needles.map((n) => n.text)).not.toContain('main');
  });
});

describe('scoreWindow', () => {
  const needles = buildNeedles([project(ALPHA, 'now'), project(BETA, 'now')]);

  it('scores nothing for output that names no project', () => {
    expect(scoreWindow('npm test\n42 passed\n', needles).size).toBe(0);
  });

  it('counts one dated-slug sighting once, not also as its short slug', () => {
    // The nested short slug must not double-score: 3 (dated), never 3 + 2.
    expect(scoreWindow(`reading ${ALPHA}/README.md`, needles).get(ALPHA)).toBe(3);
  });

  it('scores a bare short slug below a dated slug', () => {
    const short = scoreWindow('terminal-tab-project-links', needles).get(ALPHA);
    const dated = scoreWindow(ALPHA, needles).get(ALPHA);
    expect(short).toBeLessThan(dated!);
  });

  it('is case-insensitive', () => {
    expect(scoreWindow(ALPHA.toUpperCase(), needles).get(ALPHA)).toBe(3);
  });

  it('accumulates repeated sightings', () => {
    expect(scoreWindow(`${ALPHA} ${ALPHA}`, needles).get(ALPHA)).toBe(6);
  });

  it('suppresses a window that reads as a listing', () => {
    const many = Array.from({ length: BURST_DISTINCT_SLUGS + 1 }, (_, i) =>
      project(`2026-08-0${i + 1}-item-${i}`, 'now'),
    );
    const listing = many.map((p) => p.slug).join('\n');
    expect(scoreWindow(listing, buildNeedles(many)).size).toBe(0);
  });

  it('keeps a window that mentions a few projects, leaving the rest to dominance', () => {
    const scores = scoreWindow(`${ALPHA} ${ALPHA} ${BETA}`, needles);
    expect(scores.size).toBe(2);
  });
});

describe('pickSuggestion', () => {
  it('suggests nothing below the score floor', () => {
    expect(pickSuggestion(new Map([[ALPHA, 2]]))).toBeUndefined();
  });

  it('suggests a clear leader', () => {
    expect(pickSuggestion(new Map([[ALPHA, 9]]))).toBe(ALPHA);
  });

  it('suggests nothing when two projects run close together', () => {
    // A tab talking about both has not said which one it is *for*; guessing
    // would present a coin flip as a finding.
    expect(
      pickSuggestion(
        new Map([
          [ALPHA, 6],
          [BETA, 5],
        ]),
      ),
    ).toBeUndefined();
  });

  it('suggests the leader once it is clear of the runner-up', () => {
    expect(
      pickSuggestion(
        new Map([
          [ALPHA, 12],
          [BETA, 5],
        ]),
      ),
    ).toBe(ALPHA);
  });

  it('finds the leader regardless of map order', () => {
    const ascending = new Map([
      [BETA, 4],
      [ALPHA, 20],
    ]);
    const descending = new Map([
      [ALPHA, 20],
      [BETA, 4],
    ]);
    expect(pickSuggestion(ascending)).toBe(ALPHA);
    expect(pickSuggestion(descending)).toBe(ALPHA);
  });

  it('suggests nothing on a tie', () => {
    expect(
      pickSuggestion(
        new Map([
          [ALPHA, 9],
          [BETA, 9],
        ]),
      ),
    ).toBeUndefined();
  });
});

describe('suggestProjectForText', () => {
  const needles = buildNeedles([project(ALPHA, 'now'), project(BETA, 'now')]);

  it('suggests the project an agent tab keeps naming', () => {
    const transcript = [
      '[user] work on the linked-tab follow-up',
      `[assistant] Reading projects/2026-08/${ALPHA}/README.md`,
      `[assistant] Appended a timeline entry to ${ALPHA}.`,
    ].join('\n');
    expect(suggestProjectForText(transcript, needles)).toBe(ALPHA);
  });

  it('suggests nothing for a plain shell doing unrelated work', () => {
    expect(suggestProjectForText('$ npm test\n140 passed\n', needles)).toBeUndefined();
  });

  it('suggests nothing from a single passing mention', () => {
    expect(
      suggestProjectForText('see also terminal-tab-project-links for context', needles),
    ).toBeUndefined();
  });

  it('suggests nothing when the tab just listed the tree', () => {
    const many = Array.from({ length: BURST_DISTINCT_SLUGS + 2 }, (_, i) =>
      project(`2026-08-0${i + 1}-item-${i}`, 'now'),
    );
    const listing = many.map((p) => `${p.slug}  now`).join('\n');
    expect(suggestProjectForText(listing, buildNeedles(many))).toBeUndefined();
  });

  it('has no needles, so no suggestion, before the tree is loaded', () => {
    expect(suggestProjectForText(`${ALPHA} ${ALPHA} ${ALPHA}`, [])).toBeUndefined();
  });
});
