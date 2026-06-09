/**
 * Unit tests for the pure porcelain/numstat parsers in `git-details.ts`,
 * the subtree prefix-strip helper they share with `git-status-cache.ts`,
 * and one real-git integration of the subtree-scoped lookups (porcelain
 * paths are repo-root-relative even from a subtree cwd — the prefix must
 * be stripped before any stat / display).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec } from './exec';
import { getDirtyDetails, parseNumstat, parsePorcelain } from './git-details';
import { getDirtyCount, invalidateAll, stripStatusPrefix } from './git-status-cache';

describe('parsePorcelain', () => {
  it('splits the two-char code from the path, preserving whitespace', () => {
    expect(parsePorcelain(' M src/a.ts')).toEqual({ code: ' M', path: 'src/a.ts' });
    expect(parsePorcelain('M  src/b.ts')).toEqual({ code: 'M ', path: 'src/b.ts' });
    expect(parsePorcelain('?? new file.txt')).toEqual({ code: '??', path: 'new file.txt' });
    expect(parsePorcelain('D  gone.ts')).toEqual({ code: 'D ', path: 'gone.ts' });
  });

  it('collapses rename arrows to the new path', () => {
    expect(parsePorcelain('R  old.ts -> new.ts')).toEqual({ code: 'R ', path: 'new.ts' });
    expect(parsePorcelain('R  dir/old name.ts -> dir/new name.ts')).toEqual({
      code: 'R ',
      path: 'dir/new name.ts',
    });
  });
});

describe('parseNumstat', () => {
  it('parses added/deleted counts and binary rows', () => {
    const map = parseNumstat('3\t1\ta.ts\n-\t-\tbin.png\n0\t12\tb.ts\n');
    expect(map.get('a.ts')).toEqual({ added: 3, deleted: 1, binary: false });
    expect(map.get('bin.png')).toEqual({ added: null, deleted: null, binary: true });
    expect(map.get('b.ts')).toEqual({ added: 0, deleted: 12, binary: false });
  });

  it('keeps tabs inside the path and skips malformed lines', () => {
    const map = parseNumstat('1\t2\tweird\tpath.ts\nnot-a-row\n\n');
    expect(map.get('weird\tpath.ts')).toEqual({ added: 1, deleted: 2, binary: false });
    expect(map.size).toBe(1);
  });
});

describe('stripStatusPrefix', () => {
  it('strips the subtree prefix from a root-relative path', () => {
    expect(stripStatusPrefix('sub/dir/file.ts', 'sub/')).toBe('dir/file.ts');
    expect(stripStatusPrefix('sub/file.ts', 'sub/')).toBe('file.ts');
  });

  it('leaves paths alone with an empty or non-matching prefix', () => {
    expect(stripStatusPrefix('file.ts', '')).toBe('file.ts');
    expect(stripStatusPrefix('other/file.ts', 'sub/')).toBe('other/file.ts');
  });
});

describe('subtree-scoped lookups against a real repo', () => {
  let tmp: string;
  let repo: string;
  let sub: string;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    return stdout;
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'condash-details-'));
    repo = join(tmp, 'repo');
    sub = join(repo, 'sub');
    mkdirSync(sub, { recursive: true });
    await git(tmp, 'init', '-q', '-b', 'main', 'repo');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(sub, 'tracked.txt'), 'one\n');
    writeFileSync(join(repo, 'root-tracked.txt'), 'root\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'init');
    // Dirty state inside the subtree: a modified tracked file, a non-empty
    // untracked file, and a ZERO-BYTE untracked file (must be filtered —
    // before the prefix fix the stat went to `<sub>/sub/empty.txt`, missed,
    // and the filter silently no-opped).
    writeFileSync(join(sub, 'tracked.txt'), 'one\ntwo\n');
    writeFileSync(join(sub, 'full.txt'), 'content\n');
    writeFileSync(join(sub, 'empty.txt'), '');
    // Root-level noise that subtree scoping must exclude.
    writeFileSync(join(repo, 'root-tracked.txt'), 'changed\n');
    invalidateAll();
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('getDirtyCount filters the zero-byte untracked file under subtree scope', async () => {
    const count = await getDirtyCount(sub, { scopeToSubtree: true });
    // tracked.txt (modified) + full.txt (untracked, non-empty); empty.txt
    // filtered; root-tracked.txt out of scope.
    expect(count).toBe(2);
  });

  it('getDirtyDetails reports subtree-relative paths joined with numstat', async () => {
    const details = await getDirtyDetails(sub, { scopeToSubtree: true });
    expect(details).not.toBeNull();
    const paths = details!.files.map((f) => f.path).sort();
    expect(paths).toEqual(['full.txt', 'tracked.txt']);
    const tracked = details!.files.find((f) => f.path === 'tracked.txt')!;
    expect(tracked.added).toBe(1);
    expect(tracked.deleted).toBe(0);
  });

  it('getDirtyDetails keeps worktree-root paths when not subtree-scoped', async () => {
    const details = await getDirtyDetails(repo);
    expect(details).not.toBeNull();
    const paths = details!.files.map((f) => f.path).sort();
    expect(paths).toEqual(['root-tracked.txt', 'sub/full.txt', 'sub/tracked.txt']);
  });
});
