/**
 * Tests for `isGitRepo`'s filesystem fast path (#475). A registry entry pointing
 * at a repo root is answered by a `.git` stat; only an entry pointing *inside* a
 * repo still spawns `git rev-parse`. The spawn is the whole point of the change,
 * so both halves are asserted — the fast path must not spawn, and the fallback
 * must still run so a submodule subdirectory keeps reporting as a git repo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('./exec', () => ({ exec }));

const { pathExists } = vi.hoisted(() => ({ pathExists: vi.fn() }));
vi.mock('./fs-helpers', () => ({ pathExists }));

vi.mock('./git-status-cache', () => ({
  getDirtyCount: vi.fn().mockResolvedValue(0),
  getUpstreamStatus: vi.fn().mockResolvedValue(null),
}));

import { isGitRepo } from './worktrees';

beforeEach(() => {
  exec.mockReset();
  pathExists.mockReset();
});

describe('isGitRepo', () => {
  it('answers a repo root from the `.git` entry, with no subprocess', async () => {
    pathExists.mockResolvedValue(true);
    expect(await isGitRepo('/ws/alpha')).toBe(true);
    expect(pathExists).toHaveBeenCalledWith('/ws/alpha/.git');
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to git for a path inside a repo but not its root', async () => {
    // A submodule handle in the registry: no `.git` of its own, shares the
    // parent's. Only git can answer, so the spawn is expected here.
    pathExists.mockResolvedValue(false);
    exec.mockResolvedValue({ stdout: '/ws/alpha/.git/modules/inner\n', stderr: '' });
    expect(await isGitRepo('/ws/alpha/inner')).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('git', ['rev-parse', '--git-dir'], {
      cwd: '/ws/alpha/inner',
    });
  });

  it('is false when neither the stat nor git resolves', async () => {
    pathExists.mockResolvedValue(false);
    exec.mockRejectedValue(new Error('not a git repository'));
    expect(await isGitRepo('/ws/not-a-repo')).toBe(false);
  });
});
