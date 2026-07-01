import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, TreeEvent } from '@shared/types';
import { applyTreeEvents, type TreeEventsDeps } from './tree-events';

const README = '/c/projects/2026-07/slug/README.md';

function makeDeps() {
  return {
    mutateProjects: vi.fn(),
    reloadProjects: vi.fn().mockResolvedValue(undefined),
    reloadKnowledge: vi.fn().mockResolvedValue(undefined),
    reloadResources: vi.fn().mockResolvedValue(undefined),
    reloadSkills: vi.fn().mockResolvedValue(undefined),
    reloadConfig: vi.fn().mockResolvedValue(undefined),
    refetchRepos: vi.fn(),
  } satisfies TreeEventsDeps;
}

const getProject = vi.fn();

beforeEach(() => {
  getProject.mockReset().mockResolvedValue({ path: README, timeline: [] } as Project);
  // applyTreeEvents reaches window.condash.getProject for `project` events.
  (globalThis as unknown as { window: unknown }).window = { condash: { getProject } };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** The five reloaders + refetch that a full `unknown` fan-out hits. */
function expectOnlyProjectsReloaded(deps: ReturnType<typeof makeDeps>) {
  expect(deps.reloadProjects).toHaveBeenCalledTimes(1);
  expect(deps.reloadKnowledge).not.toHaveBeenCalled();
  expect(deps.reloadResources).not.toHaveBeenCalled();
  expect(deps.reloadSkills).not.toHaveBeenCalled();
  expect(deps.reloadConfig).not.toHaveBeenCalled();
  expect(deps.refetchRepos).not.toHaveBeenCalled();
}

describe('applyTreeEvents — scoped reloads (R1)', () => {
  it('projects-reload reloads only the projects list', async () => {
    const deps = makeDeps();
    await applyTreeEvents([{ kind: 'projects-reload' }], deps);
    expectOnlyProjectsReloaded(deps);
    expect(getProject).not.toHaveBeenCalled();
  });

  it('coalesces repeated projects-reload events into one reload', async () => {
    const deps = makeDeps();
    await applyTreeEvents([{ kind: 'projects-reload' }, { kind: 'projects-reload' }], deps);
    expect(deps.reloadProjects).toHaveBeenCalledTimes(1);
  });

  it('a scoped project (note) patch touches only that card, no reloaders', async () => {
    const deps = makeDeps();
    await applyTreeEvents([{ kind: 'project', op: 'change', path: README }], deps);
    expect(getProject).toHaveBeenCalledWith(README);
    expect(deps.mutateProjects).toHaveBeenCalledTimes(1);
    expect(deps.reloadProjects).not.toHaveBeenCalled();
    expect(deps.reloadKnowledge).not.toHaveBeenCalled();
    expect(deps.refetchRepos).not.toHaveBeenCalled();
  });

  it('an ignore event does nothing at all', async () => {
    const deps = makeDeps();
    await applyTreeEvents([{ kind: 'ignore' }], deps);
    expect(getProject).not.toHaveBeenCalled();
    expect(deps.mutateProjects).not.toHaveBeenCalled();
    expect(deps.reloadProjects).not.toHaveBeenCalled();
  });
});

describe('applyTreeEvents — unknown still fans out (regression guard)', () => {
  it('unknown reloads every pane and refetches repos', async () => {
    const deps = makeDeps();
    await applyTreeEvents([{ kind: 'unknown' } as TreeEvent], deps);
    expect(deps.reloadProjects).toHaveBeenCalledTimes(1);
    expect(deps.reloadKnowledge).toHaveBeenCalledTimes(1);
    expect(deps.reloadResources).toHaveBeenCalledTimes(1);
    expect(deps.reloadSkills).toHaveBeenCalledTimes(1);
    expect(deps.reloadConfig).toHaveBeenCalledTimes(1);
    expect(deps.refetchRepos).toHaveBeenCalledTimes(1);
  });
});
