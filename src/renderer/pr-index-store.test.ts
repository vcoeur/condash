/**
 * Unit tests for the pure project→PR matcher behind the Projects-pane card
 * badges. The reactive `reloadPrIndex` / `prsForProject` shell isn't exercised
 * here (it needs `window.condash` + a live gh) — only the index-matching logic.
 */
import { describe, expect, it } from 'vitest';
import type { OpenPullRequest } from '@shared/types';
import { matchProjectPrs } from './pr-index-store';

const pr = (number: number, headRefName: string, isDraft = false): OpenPullRequest => ({
  number,
  url: `https://example.com/pull/${number}`,
  title: `PR ${number}`,
  isDraft,
  headRefName,
});

describe('matchProjectPrs', () => {
  it('matches a project branch to its repo PR', () => {
    const index = new Map([['condash', [pr(1, 'main'), pr(2, 'feature-x')]]]);
    const result = matchProjectPrs(index, { apps: ['condash'], branch: 'feature-x' });
    expect(result.map((p) => p.number)).toEqual([2]);
  });

  it('returns empty when the project has no branch', () => {
    const index = new Map([['condash', [pr(2, 'feature-x')]]]);
    expect(matchProjectPrs(index, { apps: ['condash'], branch: null })).toEqual([]);
  });

  it('returns empty when no open PR has the branch as head', () => {
    const index = new Map([['condash', [pr(1, 'main')]]]);
    expect(matchProjectPrs(index, { apps: ['condash'], branch: 'feature-x' })).toEqual([]);
  });

  it('returns empty when the app has no index entry', () => {
    const index = new Map<string, OpenPullRequest[]>();
    expect(matchProjectPrs(index, { apps: ['condash'], branch: 'feature-x' })).toEqual([]);
  });

  it('searches every app of a multi-app project', () => {
    const index = new Map([
      ['condash', [pr(1, 'main')]],
      ['knoten', [pr(9, 'shared-branch')]],
    ]);
    const result = matchProjectPrs(index, {
      apps: ['condash', 'knoten'],
      branch: 'shared-branch',
    });
    expect(result.map((p) => p.number)).toEqual([9]);
  });

  it('dedupes a PR reachable through two app tokens of the same repo', () => {
    // `#condash` and `condash` both resolve to one repo, so the index can hold
    // the same PR under two keys; a card must badge it once.
    const shared = pr(5, 'feature-x');
    const index = new Map([
      ['condash', [shared]],
      ['#condash', [shared]],
    ]);
    const result = matchProjectPrs(index, {
      apps: ['condash', '#condash'],
      branch: 'feature-x',
    });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(5);
  });

  it('carries the draft flag through', () => {
    const index = new Map([['condash', [pr(7, 'feature-x', true)]]]);
    expect(matchProjectPrs(index, { apps: ['condash'], branch: 'feature-x' })[0].isDraft).toBe(
      true,
    );
  });
});
