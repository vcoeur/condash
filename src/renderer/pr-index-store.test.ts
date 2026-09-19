/**
 * Unit tests for the project→PR matcher behind the Projects-pane card badges
 * and for the `createPrIndexSync` visibility gate (B3): `gh` lookups must not
 * fire while the pane is hidden, must fire when it shows, and must track list
 * churn only while visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import type { OpenPullRequest, Project } from '@shared/types';
import { createPrIndexSync, matchProjectPrs, prsForProject, reloadPrIndex } from './pr-index-store';
import { rendererPerf } from './perf-renderer';

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

describe('reloadPrIndex — perf span (prIndexReload)', () => {
  const listOpenPullRequests = vi.fn(async (): Promise<OpenPullRequest[]> => []);
  const project = (apps: string[], branch: string | null): Project => ({ apps, branch }) as Project;

  beforeEach(() => {
    listOpenPullRequests.mockClear();
    vi.stubGlobal('window', { condash: { listOpenPullRequests } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rendererPerf.setEnabled(false);
  });

  it('records a prIndexReload span while recording is enabled', async () => {
    rendererPerf.setEnabled(true);
    await reloadPrIndex([project(['condash'], 'feature-x')]);
    const span = rendererPerf.takeReport()?.spans?.prIndexReload;
    expect(span?.n).toBe(1);
    expect(listOpenPullRequests).toHaveBeenCalledWith('condash');
  });

  it('records nothing while recording is disabled', async () => {
    await reloadPrIndex([project(['condash'], 'feature-x')]);
    expect(rendererPerf.takeReport()).toBeUndefined();
  });
});

/** One macrotask turn — settles a resolved lookup's microtask chain without
 *  touching fake timers. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('createPrIndexSync — trailing debounce', () => {
  const listOpenPullRequests = vi.fn(async (): Promise<OpenPullRequest[]> => []);
  const DEBOUNCE_MS = 1_000;
  const project = (apps: string[], branch: string | null): Project => ({ apps, branch }) as Project;

  beforeEach(() => {
    listOpenPullRequests.mockClear();
    vi.stubGlobal('window', { condash: { listOpenPullRequests } });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('coalesces rapid triggers into one reload carrying the latest list', async () => {
    const [projects, setProjects] = createSignal<Project[]>([project(['alpha'], 'b')]);
    const [visible] = createSignal(true);
    createPrIndexSync(projects, visible, DEBOUNCE_MS);

    setProjects([project(['alpha'], 'b'), project(['beta'], 'b')]);
    setProjects([project(['alpha'], 'b'), project(['beta'], 'b'), project(['gamma'], 'b')]);
    expect(listOpenPullRequests).not.toHaveBeenCalled(); // window not quiet yet

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // One batch, the latest list only: three tokens, no churn-generation calls.
    expect(listOpenPullRequests).toHaveBeenCalledTimes(3);
    expect(listOpenPullRequests).toHaveBeenCalledWith('gamma');
  });

  it('arms nothing while the pane is hidden; a show arms the timer', async () => {
    const [projects, setProjects] = createSignal<Project[]>([project(['alpha'], 'b')]);
    const [visible, setVisible] = createSignal(false);
    createPrIndexSync(projects, visible, DEBOUNCE_MS);

    setProjects([project(['alpha'], 'other-branch')]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(listOpenPullRequests).not.toHaveBeenCalled();

    setVisible(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(listOpenPullRequests).toHaveBeenCalledTimes(1);
    expect(listOpenPullRequests).toHaveBeenCalledWith('alpha');
  });

  it('drops a timer still armed when the pane hides mid-window', async () => {
    const [projects, setProjects] = createSignal<Project[]>([project(['alpha'], 'b')]);
    const [visible, setVisible] = createSignal(true);
    createPrIndexSync(projects, visible, DEBOUNCE_MS);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // first (armed-on-show) batch fires
    expect(listOpenPullRequests).toHaveBeenCalledTimes(1);

    // Re-arm, then hide before the window elapses: the pending fire is dropped.
    setProjects([project(['alpha'], 'other-branch')]);
    setVisible(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(listOpenPullRequests).toHaveBeenCalledTimes(1);
  });

  it('drops a timer still armed when the sync scope is disposed', async () => {
    const [projects, setProjects] = createSignal<Project[]>([project(['alpha'], 'b')]);
    const [visible] = createSignal(true);
    const dispose = createRoot((disposeRoot) => {
      createPrIndexSync(projects, visible, DEBOUNCE_MS);
      return disposeRoot;
    });

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // armed-on-create batch fires
    expect(listOpenPullRequests).toHaveBeenCalledTimes(1);

    // Re-arm, then tear the scope down before the window elapses: the armed
    // fire must never land into the disposed scope.
    setProjects([project(['alpha'], 'other-branch')]);
    dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(listOpenPullRequests).toHaveBeenCalledTimes(1);
  });
});

describe('reloadPrIndex — bounded pool + progressive merges', () => {
  const project = (apps: string[], branch: string | null): Project => ({ apps, branch }) as Project;

  /** Every lookup parks on a gate the test releases, so concurrency, call
   *  order, and mid-drain index state are all directly observable. */
  function gatedLookup() {
    const pending = new Map<string, (value: OpenPullRequest[]) => void>();
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const listOpenPullRequests = vi.fn((app: string): Promise<OpenPullRequest[]> => {
      order.push(app);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<OpenPullRequest[]>((resolve) => {
        pending.set(app, resolve);
      }).then((prs) => {
        inFlight -= 1;
        return prs;
      });
    });
    const release = (app: string, prs: OpenPullRequest[] = []): void => {
      const resolve = pending.get(app);
      pending.delete(app);
      resolve?.(prs);
    };
    const releaseAll = async (): Promise<void> => {
      while (pending.size > 0) {
        for (const [app, resolve] of [...pending]) {
          pending.delete(app);
          resolve([]);
        }
        await flush();
      }
    };
    return { listOpenPullRequests, order, maxInFlight: () => maxInFlight, release, releaseAll };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('caps concurrency at the pool limit and merges entries as they land', async () => {
    const apps = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    const { listOpenPullRequests, maxInFlight, release } = gatedLookup();
    vi.stubGlobal('window', { condash: { listOpenPullRequests } });

    const done = reloadPrIndex(apps.map((app) => project([app], 'b')));
    await flush(); // first wave starts
    expect(maxInFlight()).toBe(6); // 8 tokens → the cap binds
    expect(listOpenPullRequests).toHaveBeenCalledTimes(6);

    release('p1', [pr(1, 'b')]);
    await flush();
    // Progressive: p1's badge is already visible while p2..p8 are pending.
    expect(prsForProject({ apps: ['p1'], branch: 'b' }).map((p) => p.number)).toEqual([1]);
    expect(prsForProject({ apps: ['p8'], branch: 'b' })).toEqual([]);
    // The freed slot started the next token.
    expect(listOpenPullRequests).toHaveBeenCalledTimes(7);
    expect(maxInFlight()).toBeLessThanOrEqual(6);

    for (const app of ['p2', 'p3', 'p4', 'p5', 'p6']) release(app, [pr(10, 'b')]);
    await flush();
    release('p7', [pr(11, 'b')]);
    await flush();
    release('p8', [pr(12, 'b')]);
    await done;
    expect(maxInFlight()).toBeLessThanOrEqual(6);
    expect(prsForProject({ apps: ['p8'], branch: 'b' }).map((p) => p.number)).toEqual([12]);
  });

  it('drains tokens in insertion order', async () => {
    const apps = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9', 'o10'];
    const { listOpenPullRequests, order, releaseAll } = gatedLookup();
    vi.stubGlobal('window', { condash: { listOpenPullRequests } });

    const done = reloadPrIndex(apps.map((app) => project([app], 'b')));
    await flush();
    expect(order).toEqual(['o1', 'o2', 'o3', 'o4', 'o5', 'o6']);

    await releaseAll();
    await done;
    expect(order).toEqual(apps);
  });

  it('never merges a stale generation late entry into a newer index', async () => {
    const { listOpenPullRequests, release } = gatedLookup();
    vi.stubGlobal('window', { condash: { listOpenPullRequests } });

    const stale = reloadPrIndex([project(['stale-app'], 'b')]);
    await flush(); // stale lookup parked on its gate
    const fresh = reloadPrIndex([project(['fresh-app'], 'b')]);
    await flush(); // fresh lookup parked on its gate too

    release('fresh-app', [pr(7, 'b')]);
    release('stale-app', [pr(9, 'b')]); // lands after the newer reload owns the index
    await flush();
    await Promise.all([stale, fresh]);

    expect(prsForProject({ apps: ['fresh-app'], branch: 'b' }).map((p) => p.number)).toEqual([7]);
    expect(prsForProject({ apps: ['stale-app'], branch: 'b' })).toEqual([]);
  });

  it('stops pulling new tokens once a newer generation owns the index', async () => {
    const apps = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    const { listOpenPullRequests, order, releaseAll } = gatedLookup();
    vi.stubGlobal('window', { condash: { listOpenPullRequests } });

    const stale = reloadPrIndex(apps.map((app) => project([app], 'b')));
    await flush(); // first wave of 6 parked
    expect(order).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);

    void reloadPrIndex([]); // a newer generation (the clear-the-index path)
    await releaseAll(); // the stale wave settles
    await stale;
    expect(order).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']); // s7/s8 never pulled
  });

  it('keeps last-known badges for un-landed entries mid-drain over a populated index', async () => {
    const { listOpenPullRequests, release } = gatedLookup();
    vi.stubGlobal('window', { condash: { listOpenPullRequests } });
    const both = [project(['a-app'], 'b'), project(['b-app'], 'b')];

    // Batch 1 populates the index — the state a pane re-show after hide
    // (or list churn) starts from, since the index is retained while hidden.
    const first = reloadPrIndex(both);
    await flush();
    release('a-app', [pr(1, 'b')]);
    release('b-app', [pr(2, 'b')]);
    await first;
    expect(prsForProject({ apps: ['b-app'], branch: 'b' }).map((p) => p.number)).toEqual([2]);

    // Batch 2 re-fetches both; a-app resolves first. b-app must keep its
    // batch-1 badge while its own lookup is in flight, not blank out.
    const second = reloadPrIndex(both);
    await flush();
    release('a-app', [pr(3, 'b')]);
    await flush();
    expect(prsForProject({ apps: ['b-app'], branch: 'b' }).map((p) => p.number)).toEqual([2]);
    expect(prsForProject({ apps: ['a-app'], branch: 'b' }).map((p) => p.number)).toEqual([3]);

    release('b-app', [pr(4, 'b')]);
    await second;
    expect(prsForProject({ apps: ['b-app'], branch: 'b' }).map((p) => p.number)).toEqual([4]);
  });

  it('prunes entries whose project left the list once the drain completes', async () => {
    const { listOpenPullRequests, release } = gatedLookup();
    vi.stubGlobal('window', { condash: { listOpenPullRequests } });

    const first = reloadPrIndex([
      project(['stay-app'], 'b'),
      project(['gone-app'], 'b'),
      project(['parked-app'], 'b'),
    ]);
    await flush();
    release('stay-app', [pr(1, 'b')]);
    release('gone-app', [pr(2, 'b')]);
    release('parked-app', [pr(9, 'b')]);
    await first;

    // The list churns: gone-app's project is no longer in it. Its lookup is
    // not in the batch either — parked-app's stays in flight so the drain
    // (and with it the exact swap) is still pending at the mid-drain read.
    const second = reloadPrIndex([project(['stay-app'], 'b'), project(['parked-app'], 'b')]);
    await flush();
    release('stay-app', [pr(5, 'b')]);
    await flush();
    // Mid-drain the seeded view still carries gone-app's last-known badge...
    expect(prsForProject({ apps: ['gone-app'], branch: 'b' }).map((p) => p.number)).toEqual([2]);
    expect(prsForProject({ apps: ['stay-app'], branch: 'b' }).map((p) => p.number)).toEqual([5]);
    release('parked-app', [pr(8, 'b')]);
    await second;
    // ...until the exact swap lands: the end state is the batch's own result.
    expect(prsForProject({ apps: ['gone-app'], branch: 'b' })).toEqual([]);
    expect(prsForProject({ apps: ['stay-app'], branch: 'b' }).map((p) => p.number)).toEqual([5]);
    expect(prsForProject({ apps: ['parked-app'], branch: 'b' }).map((p) => p.number)).toEqual([8]);
  });
});
