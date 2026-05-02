import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bootApp } from './fixtures/electron-app';

const exec = promisify(execFile);

/** Initialise a tiny git repo at `dir` with one tracked file and an
 *  initial commit, so that subsequent edits register as dirty. */
async function seedRepo(dir: string): Promise<void> {
  await exec('git', ['init', '-q', dir]);
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  await writeFile(join(dir, 'README.md'), '# initial\n', 'utf8');
  await exec('git', ['-C', dir, 'add', 'README.md']);
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

test('getDirtyDetails returns parsed file list + numstat for a dirty worktree', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'condash-dirty-badge-'));
  try {
    await seedRepo(repoDir);
    // Modify the tracked file + drop an untracked file at the repo root
    // (porcelain v1 with default -u=normal collapses untracked subdirs to
    // the dir entry, so the file must be at the top level to surface as
    // its own line).
    await writeFile(join(repoDir, 'README.md'), '# initial\nplus a new line\n', 'utf8');
    await writeFile(join(repoDir, 'note.txt'), 'fresh\n', 'utf8');

    const booted = await bootApp();
    try {
      const details = await booted.window.evaluate(
        (path) => window.condash.getDirtyDetails(path),
        repoDir,
      );

      expect(details).not.toBeNull();
      const files = details!.files;
      // One tracked-modified + one untracked file.
      expect(files.length).toBe(2);

      const readme = files.find((f) => f.path.endsWith('README.md'));
      expect(readme).toBeDefined();
      // Modified-but-not-staged shows up as ` M` in `git status --porcelain`.
      expect(readme!.code.trim()).toBe('M');
      // The tracked edit (one added line) shows up in numstat as +1/-0.
      expect(readme!.added).toBe(1);
      expect(readme!.deleted).toBe(0);
      expect(readme!.binary).toBe(false);

      const untracked = files.find((f) => f.path === 'note.txt');
      expect(untracked).toBeDefined();
      expect(untracked!.code).toBe('??');
      // Untracked files have no numstat row — added/deleted are null.
      expect(untracked!.added).toBeNull();
      expect(untracked!.deleted).toBeNull();

      // Aggregates cover tracked changes only; the README's +1 is the only contribution.
      expect(details!.totalAdded).toBe(1);
      expect(details!.totalDeleted).toBe(0);
      expect(details!.truncated).toBe(false);
      expect(details!.totalCount).toBe(2);
    } finally {
      await booted.cleanup();
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('getDirtyDetails returns an empty list for a clean worktree', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'condash-dirty-badge-clean-'));
  try {
    await seedRepo(repoDir);

    const booted = await bootApp();
    try {
      const details = await booted.window.evaluate(
        (path) => window.condash.getDirtyDetails(path),
        repoDir,
      );
      expect(details).not.toBeNull();
      expect(details!.files).toEqual([]);
      expect(details!.totalAdded).toBe(0);
      expect(details!.totalDeleted).toBe(0);
      expect(details!.truncated).toBe(false);
      expect(details!.totalCount).toBe(0);
    } finally {
      await booted.cleanup();
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});
