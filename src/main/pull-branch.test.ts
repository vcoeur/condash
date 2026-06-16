/**
 * Unit tests for the pure pull-output classifiers plus one real-git
 * integration of `pullBranch` end-to-end: a clone fast-forwarding to new
 * upstream commits, the already-in-sync case, the dirty refusal, and a
 * diverged branch that can't fast-forward.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec } from './exec';
import { invalidateAll } from './git-status-cache';
import { classifyPullFailure, classifyPullSuccess, pullBranch } from './pull-branch';

describe('classifyPullSuccess', () => {
  it('detects an already-up-to-date pull', () => {
    expect(classifyPullSuccess('Already up to date.\n')).toEqual({
      status: 'up-to-date',
      message: 'Already up to date',
    });
    // Older git spelling.
    expect(classifyPullSuccess('Already up-to-date.\n').status).toBe('up-to-date');
  });

  it('reports a fast-forward with the commit range when present', () => {
    const out = 'Updating 1a2b3c4..5d6e7f8\nFast-forward\n file.txt | 1 +\n';
    expect(classifyPullSuccess(out)).toEqual({
      status: 'updated',
      message: 'Fast-forwarded (1a2b3c4..5d6e7f8)',
    });
  });

  it('falls back to a generic updated message when no range is printed', () => {
    expect(classifyPullSuccess('Fast-forward\n')).toEqual({
      status: 'updated',
      message: 'Fast-forwarded to upstream',
    });
  });
});

describe('classifyPullFailure', () => {
  it('maps a non-fast-forward error to a diverged result', () => {
    expect(classifyPullFailure('fatal: Not possible to fast-forward, aborting.')).toEqual({
      status: 'diverged',
      message: 'Branch has diverged from upstream — fast-forward not possible',
    });
  });

  it('returns null for an unrecognised failure (rethrow path)', () => {
    expect(classifyPullFailure('fatal: could not read from remote repository')).toBeNull();
    expect(classifyPullFailure('there is no tracking information')).toBeNull();
  });
});

describe('pullBranch against a real repo', () => {
  let tmp: string;
  let remote: string;
  let work: string;
  let local: string;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    return stdout;
  }

  async function commitTo(
    repo: string,
    file: string,
    body: string,
    message: string,
  ): Promise<void> {
    writeFileSync(join(repo, file), body);
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', message);
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'condash-pull-'));
    remote = join(tmp, 'remote.git');
    work = join(tmp, 'work');
    local = join(tmp, 'local');

    // Bare remote seeded from a working clone, so `local` clones with an
    // `origin/main` upstream already configured (what `--ff-only` needs).
    await git(tmp, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
    await git(tmp, 'clone', '-q', remote, 'work');
    await git(work, 'config', 'user.email', 'test@example.com');
    await git(work, 'config', 'user.name', 'Test');
    await commitTo(work, 'file.txt', 'one\n', 'init');
    await git(work, 'push', '-q', '-u', 'origin', 'main');

    await git(tmp, 'clone', '-q', remote, 'local');
    await git(local, 'config', 'user.email', 'dev@example.com');
    await git(local, 'config', 'user.name', 'Dev');
    invalidateAll();
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports up-to-date when the clone is already in sync', async () => {
    const result = await pullBranch(local);
    expect(result.status).toBe('up-to-date');
  });

  it('fast-forwards when upstream has new commits', async () => {
    await commitTo(work, 'file.txt', 'one\ntwo\n', 'second');
    await git(work, 'push', '-q', 'origin', 'main');
    invalidateAll();
    const result = await pullBranch(local);
    expect(result.status).toBe('updated');
  });

  it('refuses on a dirty working tree', async () => {
    writeFileSync(join(local, 'scratch.txt'), 'uncommitted\n');
    invalidateAll();
    const result = await pullBranch(local);
    expect(result.status).toBe('dirty');
    // Clean up so the divergence test starts from a clean tree.
    rmSync(join(local, 'scratch.txt'));
    invalidateAll();
  });

  it('reports a diverged branch that cannot fast-forward', async () => {
    // Local advances on its own commit...
    await commitTo(local, 'file.txt', 'one\ntwo\nlocal\n', 'local-only');
    // ...while upstream advances on a different one.
    await commitTo(work, 'file.txt', 'one\ntwo\nremote\n', 'remote-only');
    await git(work, 'push', '-q', 'origin', 'main');
    invalidateAll();
    const result = await pullBranch(local);
    expect(result.status).toBe('diverged');
  });
});
