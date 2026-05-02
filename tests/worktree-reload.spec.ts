/**
 * Code panel auto-refreshes on `git worktree add` / `git worktree
 * remove`. Regression test for the v2.10.1 fix — the panel was
 * previously holding stale rows until the user toggled the panel off
 * and on. The structural FS watcher in `repo-watchers.ts` should now
 * push a `repo-worktrees-changed` event that triggers a per-primary
 * reload in the renderer within ≤ 1 s.
 */
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bootApp } from './fixtures/electron-app';

const exec = promisify(execFile);

async function seedRepo(dir: string): Promise<void> {
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  await writeFile(join(dir, 'README.md'), '# initial\n', 'utf8');
  await exec('git', ['-C', dir, 'add', 'README.md']);
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

test('Code panel reflects git worktree add/remove without manual refresh', async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'condash-wt-reload-ws-'));
  const repoDir = join(workspaceDir, 'demo-repo');
  await mkdir(repoDir);
  await seedRepo(repoDir);

  const worktreeRoot = await mkdtemp(join(tmpdir(), 'condash-wt-reload-worktrees-'));
  const featureWorktreeDir = join(worktreeRoot, 'feature', 'demo-repo');

  const booted = await bootApp({
    extraConfig: {
      workspace_path: workspaceDir,
      worktrees_path: worktreeRoot,
      repositories: {
        primary: ['demo-repo'],
      },
    },
  });

  try {
    // Repo row should mount with a single primary worktree row (`main`).
    const branchRows = booted.window.locator('.repo-row .branch-row .branch-name');
    await expect(branchRows).toHaveText(['main'], { timeout: 5000 });

    // Add a feature worktree from outside the running app — exactly the
    // scenario the fix targets (CLI mutation, no IPC notification path).
    await mkdir(join(worktreeRoot, 'feature'), { recursive: true });
    await exec('git', [
      '-C',
      repoDir,
      'worktree',
      'add',
      '-b',
      'feature',
      featureWorktreeDir,
    ]);

    // Expect the new branch row to appear without any UI interaction.
    // 2 s budget covers the 250 ms structural debounce + IPC + reload.
    // Order is "primary first, then secondary worktrees alpha" (see
    // orderedWorktrees() in tabs/code.tsx).
    await expect(branchRows).toHaveText(['main', 'feature'], { timeout: 2000 });

    // Remove the worktree — the row should disappear within the same
    // budget. This is the exact stale-row bug from the incident.
    await exec('git', ['-C', repoDir, 'worktree', 'remove', featureWorktreeDir]);

    await expect(branchRows).toHaveText(['main'], { timeout: 2000 });
  } finally {
    await booted.cleanup();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  }
});
