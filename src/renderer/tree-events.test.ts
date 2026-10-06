import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import type { Project, TreeEvent } from '@shared/types';
import { applyTreeEvents, type TreeEventsDeps } from './tree-events';
import { createProjectsStore } from './projects-store';
import { rendererPerf } from './perf-renderer';

const README = '/c/projects/2026-07/slug/README.md';
const OTHER = '/c/projects/2026-07/other/README.md';

/**
 * The dispatcher is tested against a *real* projects store: the batch
 * ownership under test lives in the store, and the patch path exercises
 * its ticket-gated `settle` end to end.
 */
const flushEffects = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function makeDeps() {
  const [conceptionPath] = createSignal<string | null>('/c');
  let store!: ReturnType<typeof createProjectsStore>;
  createRoot((dispose) => {
    store = createProjectsStore({ conceptionPath });
    return dispose;
  });
  // Let the store's boot read settle before a test seeds the list — its
  // commit would otherwise land after (and clobber) a synchronous seed.
  await flushEffects();
  return {
    store,
    projectOwnership: store.ownership,
    mutateProjects: store.mutate,
    reloadProjects: vi.fn().mockResolvedValue(undefined),
    reloadKnowledge: vi.fn().mockResolvedValue(undefined),
    reloadResources: vi.fn().mockResolvedValue(undefined),
    reloadSkills: vi.fn().mockResolvedValue(undefined),
    reloadConfig: vi.fn().mockResolvedValue(undefined),
    refetchRepos: vi.fn(),
  } satisfies TreeEventsDeps & { store: ReturnType<typeof createProjectsStore> };
}

const getProject = vi.fn();
const listProjects = vi.fn();

function projectRow(path: string, title: string): Project {
  return {
    path,
    slug: path.split('/').pop() ?? path,
    title,
    timeline: [],
  } as unknown as Project;
}

beforeEach(() => {
  // Only `path` + `timeline` are read by applyTreeEvents' patch path.
  getProject.mockReset().mockImplementation(async (path: string) => projectRow(path, 'base'));
  // The store's eager conception effect calls listProjects on mount.
  listProjects.mockReset().mockResolvedValue([]);
  // applyTreeEvents reaches window.condash.getProject for `project` events.
  (globalThis as unknown as { window: unknown }).window = {
    condash: { getProject, listProjects },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** The five reloaders + refetch that a full `unknown` fan-out hits. */
type Deps = Awaited<ReturnType<typeof makeDeps>>;

function expectOnlyProjectsReloaded(deps: Deps) {
  expect(deps.reloadProjects).toHaveBeenCalledTimes(1);
  expect(deps.reloadKnowledge).not.toHaveBeenCalled();
  expect(deps.reloadResources).not.toHaveBeenCalled();
  expect(deps.reloadSkills).not.toHaveBeenCalled();
  expect(deps.reloadConfig).not.toHaveBeenCalled();
  expect(deps.refetchRepos).not.toHaveBeenCalled();
}

describe('applyTreeEvents — scoped reloads (R1)', () => {
  it('projects-reload reloads only the projects list', async () => {
    const deps = await makeDeps();
    await applyTreeEvents([{ kind: 'projects-reload' }], deps);
    expectOnlyProjectsReloaded(deps);
    expect(getProject).not.toHaveBeenCalled();
  });

  it('coalesces repeated projects-reload events into one reload', async () => {
    const deps = await makeDeps();
    await applyTreeEvents([{ kind: 'projects-reload' }, { kind: 'projects-reload' }], deps);
    expect(deps.reloadProjects).toHaveBeenCalledTimes(1);
  });

  it('a scoped project (note) patch touches only that card, no reloaders', async () => {
    const deps = await makeDeps();
    await applyTreeEvents([{ kind: 'project', op: 'change', path: README }], deps);
    expect(getProject).toHaveBeenCalledWith(README);
    expect(deps.store.projects().map((p) => p.path)).toEqual([README]);
    expect(deps.reloadProjects).not.toHaveBeenCalled();
    expect(deps.reloadKnowledge).not.toHaveBeenCalled();
    expect(deps.refetchRepos).not.toHaveBeenCalled();
  });

  it('an ignore event does nothing at all', async () => {
    const deps = await makeDeps();
    await applyTreeEvents([{ kind: 'ignore' }], deps);
    expect(getProject).not.toHaveBeenCalled();
    expect(deps.store.projects()).toEqual([]);
    expect(deps.reloadProjects).not.toHaveBeenCalled();
  });
});

describe('applyTreeEvents — batch pre-registration (race-safe freshness)', () => {
  it('registers the whole batch before the first await: a same-batch unlink defeats the held lookup', async () => {
    const deps = await makeDeps();
    // Seed the list with both projects, as the resident list would hold them.
    deps.mutateProjects((items) => [...items, projectRow(README, 'A'), projectRow(OTHER, 'B')]);

    let resolveA!: (value: Project) => void;
    getProject.mockImplementation((path: string) => {
      if (path !== OTHER) throw new Error('lookup for a superseded path must not be issued');
      return new Promise<Project>((resolve) => {
        resolveA = resolve;
      });
    });

    const batch: TreeEvent[] = [
      { kind: 'project', op: 'change', path: README },
      { kind: 'project', op: 'unlink', path: README },
      { kind: 'project', op: 'change', path: OTHER },
    ];
    const done = applyTreeEvents(batch, deps);

    // All batch operations are registered before any lookup is awaited:
    // the change for README is superseded by its unlink, so no getProject
    // may be issued for it — only OTHER's lookup is in flight here.
    expect(getProject).toHaveBeenCalledTimes(1);
    expect(getProject).toHaveBeenCalledWith(OTHER);

    resolveA(projectRow(OTHER, 'B2'));
    await done;
    await Promise.resolve();

    // A stays deleted (its held response can never resurrect it), B patched.
    // (filter(Boolean): the vitest build pins solid-js's dev store, whose
    // keyed reconcile leaves a null hole when an array shrinks — the prod
    // build trims, and the shipped unlink path relies on that.)
    const rows = deps.store.projects().filter(Boolean);
    expect(rows.map((p) => p.path)).toEqual([OTHER]);
    expect(rows[0].title).toBe('B2');
  });

  it('a later batch supersedes an earlier batch\u2019s held lookup', async () => {
    const deps = await makeDeps();
    deps.mutateProjects((items) => [...items, projectRow(README, 'A')]);

    const resolutions: ((value: Project) => void)[] = [];
    getProject.mockImplementation(
      () =>
        new Promise<Project>((resolve) => {
          resolutions.push(resolve);
        }),
    );

    const first = applyTreeEvents([{ kind: 'project', op: 'change', path: README }], deps);
    expect(getProject).toHaveBeenCalledTimes(1);

    // A second batch re-registers the same path before the first reply lands.
    const second = applyTreeEvents([{ kind: 'project', op: 'change', path: README }], deps);
    expect(getProject).toHaveBeenCalledTimes(2);

    resolutions[1](projectRow(README, 'from-second-batch'));
    await second;
    resolutions[0](projectRow(README, 'stale-from-first-batch'));
    await first;
    await Promise.resolve();

    expect(
      deps.store
        .projects()
        .filter(Boolean)
        .map((p) => p.title),
    ).toEqual(['from-second-batch']);
  });

  it('a failed patch lookup releases the pending gate and follows the unknown fan-out', async () => {
    const deps = await makeDeps();
    getProject.mockRejectedValue(new Error('boom'));
    await applyTreeEvents([{ kind: 'project', op: 'change', path: README }], deps);
    // The unknown backstop reloaded every pane, and the failed lookup did
    // not strand the pending gate (the store's list gate is free again —
    // asserted store-side in projects-store.test.ts).
    expect(deps.reloadProjects).toHaveBeenCalledTimes(1);
    expect(deps.reloadKnowledge).toHaveBeenCalledTimes(1);
    expect(deps.reloadResources).toHaveBeenCalledTimes(1);
    expect(deps.reloadSkills).toHaveBeenCalledTimes(1);
    expect(deps.reloadConfig).toHaveBeenCalledTimes(1);
    expect(deps.refetchRepos).toHaveBeenCalledTimes(1);
  });

  it('still applies unrelated patches from a batch whose other path failed', async () => {
    const deps = await makeDeps();
    getProject.mockImplementation((path: string) =>
      path === README ? Promise.reject(new Error('boom')) : Promise.resolve(projectRow(path, 'ok')),
    );
    await applyTreeEvents(
      [
        { kind: 'project', op: 'change', path: README },
        { kind: 'project', op: 'change', path: OTHER },
      ],
      deps,
    );
    expect(deps.store.projects().map((p) => [p.path, p.title])).toEqual([[OTHER, 'ok']]);
  });
});

describe('applyTreeEvents — unknown still fans out (regression guard)', () => {
  it('unknown reloads every pane and refetches repos', async () => {
    const deps = await makeDeps();
    await applyTreeEvents([{ kind: 'unknown' } as TreeEvent], deps);
    expect(deps.reloadProjects).toHaveBeenCalledTimes(1);
    expect(deps.reloadKnowledge).toHaveBeenCalledTimes(1);
    expect(deps.reloadResources).toHaveBeenCalledTimes(1);
    expect(deps.reloadSkills).toHaveBeenCalledTimes(1);
    expect(deps.reloadConfig).toHaveBeenCalledTimes(1);
    expect(deps.refetchRepos).toHaveBeenCalledTimes(1);
  });
});

describe('applyTreeEvents — perf span (treeApplyEvents)', () => {
  afterEach(() => {
    rendererPerf.setEnabled(false);
  });

  it('records one treeApplyEvents span per batch while recording is enabled', async () => {
    rendererPerf.setEnabled(true);
    const deps = await makeDeps();
    await applyTreeEvents([{ kind: 'unknown' } as TreeEvent], deps);
    await applyTreeEvents([{ kind: 'projects-reload' }], deps);
    expect(rendererPerf.takeReport()?.spans?.treeApplyEvents?.n).toBe(2);
  });

  it('records nothing while recording is disabled', async () => {
    const deps = await makeDeps();
    await applyTreeEvents([{ kind: 'unknown' } as TreeEvent], deps);
    expect(rendererPerf.takeReport()).toBeUndefined();
  });
});
