/**
 * Unit tests for the project→PR matcher behind the Projects-pane card badges
 * and for the `createPrIndexSync` visibility gate (B3): `gh` lookups must not
 * fire while the pane is hidden, must fire when it shows, and must track list
 * churn only while visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import type { OpenPullRequest, Project } from '@shared/types';
import { createPrIndexSync, matchProjectPrs } from './pr-index-store';

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

describe('createPrIndexSync — visibility gate (B3)', () => {
  const listOpenPullRequests = vi.fn(async (): Promise<OpenPullRequest[]> => []);

  const flushMicrotasks = async (): Promise<void> => {
    // reloadPrIndex is one IPC round per app + a Promise.all — a macrotask
    // flush settles it without touching fake timers.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const project = (apps: string[], branch: string | null): Project => ({ apps, branch }) as Project;

  beforeEach(() => {
    listOpenPullRequests.mockClear();
    vi.stubGlobal('window', { condash: { listOpenPullRequests } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not fetch while the pane is hidden, fetches when it becomes visible', async () => {
    const [projects, setProjects] = createSignal<Project[]>([project(['condash'], 'feature-x')]);
    const [visible, setVisible] = createSignal(false);
    createPrIndexSync(projects, visible);

    await flushMicrotasks();
    expect(listOpenPullRequests).not.toHaveBeenCalled();

    setVisible(true);
    await flushMicrotasks();
    expect(listOpenPullRequests).toHaveBeenCalledTimes(1);
    expect(listOpenPullRequests).toHaveBeenCalledWith('condash');

    // List churn while the pane is hidden: no fan-out.
    setVisible(false);
    setProjects([project(['condash'], 'other-branch')]);
    await flushMicrotasks();
    expect(listOpenPullRequests).toHaveBeenCalledTimes(1);
  });

  it('tracks project-list churn only while the pane is visible', async () => {
    const [projects, setProjects] = createSignal<Project[]>([project(['condash'], 'feature-x')]);
    const [visible, setVisible] = createSignal(true);
    createPrIndexSync(projects, visible);

    await flushMicrotasks();
    expect(listOpenPullRequests).toHaveBeenCalledTimes(1);

    setProjects([project(['condash'], 'other-branch')]);
    await flushMicrotasks();
    expect(listOpenPullRequests).toHaveBeenCalledTimes(2);
    expect(listOpenPullRequests).toHaveBeenLastCalledWith('condash');

    // Hiding then re-showing re-runs the sync (fresh badges on pane open).
    setVisible(false);
    setVisible(true);
    await flushMicrotasks();
    expect(listOpenPullRequests).toHaveBeenCalledTimes(3);
  });

  it('resolves an empty project list without calling out', async () => {
    const [projects] = createSignal<Project[]>([]);
    const [visible] = createSignal(true);
    createPrIndexSync(projects, visible);

    await flushMicrotasks();
    expect(listOpenPullRequests).not.toHaveBeenCalled();
  });
});
