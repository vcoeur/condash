/**
 * Unit tests for the boot repo-prewarm slot (B5) and for the per-refresh git
 * spawn budget (#475). The slot lets the renderer's first `listRepos` reuse the
 * whenReady-time scan, but it must be dropped on a conception switch (and after
 * a TTL) so a later call never awaits a slot warmed for a different tree / a
 * stale boot. An empty effective config means `listRepos` short-circuits to `[]`
 * without touching git, so a config-read counter is a clean proxy for "did a
 * fresh scan run".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getEffectiveConceptionConfig } = vi.hoisted(() => ({
  getEffectiveConceptionConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock('./effective-config', () => ({ getEffectiveConceptionConfig }));

const { getCurrentBranch, isGitRepo, listWorktrees } = vi.hoisted(() => ({
  getCurrentBranch: vi.fn(),
  isGitRepo: vi.fn(),
  listWorktrees: vi.fn(),
}));
vi.mock('./worktrees', () => ({ getCurrentBranch, isGitRepo, listWorktrees }));

const { getDirtyCount, getUpstreamStatus } = vi.hoisted(() => ({
  getDirtyCount: vi.fn(),
  getUpstreamStatus: vi.fn(),
}));
vi.mock('./git-status-cache', () => ({ getDirtyCount, getUpstreamStatus }));

const { pathExists } = vi.hoisted(() => ({ pathExists: vi.fn() }));
vi.mock('./fs-helpers', () => ({ pathExists }));

import { clearBootRepos, listRepos, listReposReusingBoot, prewarmRepos } from './repos';

const PATH_A = '/home/alice/src/vcoeur/conception';
const PATH_B = '/home/alice/src/other-conception';

beforeEach(() => {
  clearBootRepos();
  getEffectiveConceptionConfig.mockClear();
  getEffectiveConceptionConfig.mockResolvedValue({});
  pathExists.mockReset().mockResolvedValue(true);
  isGitRepo.mockReset().mockResolvedValue(true);
  listWorktrees
    .mockReset()
    .mockImplementation(async (repoPath: string) => [
      { path: repoPath, branch: 'main', primary: true },
    ]);
  getCurrentBranch.mockReset().mockResolvedValue('main');
  getDirtyCount.mockReset().mockResolvedValue(0);
  getUpstreamStatus.mockReset().mockResolvedValue(null);
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('boot repo-prewarm slot (B5)', () => {
  it('reuses the boot scan for the same tree — no second config read', async () => {
    await prewarmRepos(PATH_A);
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(1);
    await listReposReusingBoot(PATH_A);
    // Reused the stashed promise: the config was NOT read a second time.
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a slot after clearBootRepos (conception switch)', async () => {
    await prewarmRepos(PATH_A);
    clearBootRepos();
    await listReposReusingBoot(PATH_A);
    // Slot dropped → a fresh scan ran (second config read).
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a slot warmed for a different tree', async () => {
    await prewarmRepos(PATH_A);
    await listReposReusingBoot(PATH_B);
    // Path mismatch → fresh scan for B.
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(2);
  });

  it('refuses a slot older than the TTL (switch away, switch back much later)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    await prewarmRepos(PATH_A);
    // Jump well past the 30 s TTL — the stale slot must be refused and rescanned.
    vi.setSystemTime(new Date(1_700_000_000_000 + 60_000));
    await listReposReusingBoot(PATH_A);
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(2);
  });

  it('is consumed one-shot — a second reuse call rescans', async () => {
    await prewarmRepos(PATH_A);
    await listReposReusingBoot(PATH_A); // consumes the slot (1 read total)
    await listReposReusingBoot(PATH_A); // slot gone → fresh scan (2 reads)
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(2);
  });
});

describe('listRepos git budget (#475)', () => {
  const CONFIG = {
    workspace_path: '/ws',
    repositories: [{ name: 'alpha', submodules: ['inner'] }, { name: 'beta' }],
  };

  beforeEach(() => {
    getEffectiveConceptionConfig.mockResolvedValue(CONFIG);
  });

  it('lists each top-level repo’s worktrees once, not twice', async () => {
    await listRepos(PATH_A);
    // `resolveParentWorktrees` runs `git worktree list` per top-level repo and
    // `buildEntry` reuses that result. Before the fix the top-level branch of
    // `buildEntry` re-ran the command, doubling it to four calls here and to 32
    // on the 16-parent registry the issue was measured against.
    expect(listWorktrees).toHaveBeenCalledTimes(2);
    expect(listWorktrees.mock.calls.map((c) => c[0]).sort()).toEqual(['/ws/alpha', '/ws/beta']);
  });

  it('still returns each top-level repo’s worktrees', async () => {
    const entries = await listRepos(PATH_A);
    const alpha = entries.find((e) => e.name === 'alpha');
    expect(alpha?.worktrees).toEqual([{ path: '/ws/alpha', branch: 'main', primary: true }]);
  });

  it('still re-roots a submodule onto its parent’s worktrees', async () => {
    const entries = await listRepos(PATH_A);
    // `RepoEntry.name` carries the display form, so a submodule reads as
    // `<parent>/<child>`.
    const inner = entries.find((e) => e.name === 'alpha/inner');
    expect(inner?.parent).toBe('alpha');
    expect(inner?.worktrees?.map((w) => w.path)).toEqual(['/ws/alpha/inner']);
  });

  it('keeps the per-primary partial reload returning worktrees', async () => {
    // `listReposForPrimary` builds a one-entry parent map. The reuse must key
    // off that map correctly here too, or the structural-watcher path would
    // re-render the primary with no worktrees at all.
    const { listReposForPrimary } = await import('./repos');
    const entries = await listReposForPrimary(PATH_A, 'beta');
    expect(entries.map((e) => e.name)).toEqual(['beta']);
    expect(entries[0]?.worktrees?.map((w) => w.path)).toEqual(['/ws/beta']);
  });
});
