/**
 * Rebuild-trigger tests for the Code-pane repo watchers (M8b).
 *
 *   - a `.gitignore` change fires the worktree watcher's handler, which must
 *     rebuild the per-root gitignore matcher (so new rules govern subsequent
 *     events / descent);
 *   - `git worktree remove` of the last worktree unlinks `.git/worktrees/`,
 *     killing the inotify watch beneath the structural watcher — the module
 *     must re-arm (rewire) a fresh structural watcher so the next
 *     `git worktree add` is still seen;
 *   - re-arming the whole watcher set refreshes scalar dirty/upstream state and
 *     broadcasts a synthetic `repo-worktrees-changed` for every primary so the
 *     renderer closes the FS-event gap (S3);
 *   - the global excludes file is resolved on every watcher build, not cached
 *     for the process lifetime (C3).
 *
 * chokidar is mocked with an injectable fake watcher so the rebuild logic is
 * driven deterministically (no real FS-event timing) — the matcher's matching
 * semantics and the readRuleText precedence are covered by
 * `gitignore-matcher.test.ts`. git-status-cache + electron are stubbed so a
 * scheduled recompute never touches real git or a BrowserWindow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface FakeWatcher {
  paths: string | string[];
  handlers: Record<string, ((...args: unknown[]) => void)[]>;
  closed: boolean;
  on(event: string, cb: (...args: unknown[]) => void): FakeWatcher;
  emit(event: string, ...args: unknown[]): void;
  close(): Promise<void>;
}

const h = vi.hoisted(() => {
  const created: FakeWatcher[] = [];
  const fakeWatch = (paths: string | string[]): FakeWatcher => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const w: FakeWatcher = {
      paths,
      handlers,
      closed: false,
      on(event, cb) {
        (handlers[event] ??= []).push(cb);
        return w;
      },
      emit(event, ...args) {
        for (const cb of handlers[event] ?? []) cb(...args);
      },
      close: async () => {
        w.closed = true;
      },
    };
    created.push(w);
    return w;
  };
  return {
    created,
    fakeWatch,
    buildGitignoreMatcher: vi.fn(() => ({ ignores: () => false })),
    readRuleText: vi.fn(() => ''),
    execFile: vi.fn(),
    safeSend: vi.fn(),
  };
});

vi.mock('chokidar', () => ({ default: { watch: h.fakeWatch }, watch: h.fakeWatch }));
vi.mock('./gitignore-matcher', () => ({
  buildGitignoreMatcher: h.buildGitignoreMatcher,
  readRuleText: h.readRuleText,
}));
vi.mock('./git-status-cache', () => ({
  getDirtyCount: vi.fn(async () => 0),
  getUpstreamStatus: vi.fn(async () => ({ ahead: 0, behind: 0, hasUpstream: false })),
  invalidateForPath: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {} }] },
}));
vi.mock('node:child_process', () => ({ execFile: h.execFile }));
vi.mock('./safe-send', () => ({ safeSend: h.safeSend }));

import {
  setRepoWatchers,
  disposeRepoWatchers,
  setRepoWatchersForRepos,
  syncRepoWatchersForPrimary,
} from './repo-watchers';
import type { RepoEntry } from '../shared/types';

describe('repo-watchers — rebuild triggers (M8b)', () => {
  let root: string;

  beforeEach(async () => {
    h.created.length = 0;
    h.buildGitignoreMatcher.mockClear();
    h.readRuleText.mockClear();
    h.safeSend.mockClear();
    // A stable "global excludes file" path so the watcher build path is exercised.
    h.execFile.mockImplementation((_cmd, args, cb) => {
      if (args && args[0] === 'config' && args[1] === '--get' && args[2] === 'core.excludesFile') {
        cb(null, { stdout: join(root, 'global-excludes') });
      } else {
        cb(null, { stdout: '' });
      }
    });
    root = await mkdtemp(join(tmpdir(), 'condash-repo-watchers-'));
  });

  afterEach(async () => {
    await disposeRepoWatchers();
    await rm(root, { recursive: true, force: true });
  });

  it('rebuilds the gitignore matcher when .gitignore changes', async () => {
    await setRepoWatchers([{ path: root, scopeToSubtree: false, isPrimary: true }]);
    // Setup builds exactly one matcher for the root.
    expect(h.buildGitignoreMatcher).toHaveBeenCalledTimes(1);

    // The worktree watcher is the one whose watch target is the bare root path.
    const worktree = h.created.find((w) => w.paths === root);
    expect(worktree).toBeDefined();

    // A `.gitignore` change fires the 'all' handler → matcher rebuilt.
    worktree!.emit('all', 'change', join(root, '.gitignore'));
    expect(h.buildGitignoreMatcher).toHaveBeenCalledTimes(2);

    // An ordinary file change must NOT rebuild the matcher.
    worktree!.emit('all', 'change', join(root, 'src', 'index.ts'));
    expect(h.buildGitignoreMatcher).toHaveBeenCalledTimes(2);
  });

  it('re-arms the structural watcher when .git/worktrees is unlinked', async () => {
    await setRepoWatchers([{ path: root, scopeToSubtree: false, isPrimary: true }]);

    const headPath = join(root, '.git', 'HEAD');
    const adminPath = join(root, '.git', 'worktrees');
    // The structural watcher is the one whose path array includes .git/HEAD.
    const structural = h.created.find((w) => Array.isArray(w.paths) && w.paths.includes(headPath));
    expect(structural).toBeDefined();
    const createdBefore = h.created.length;

    // `git worktree remove` of the last worktree unlinks the admin dir itself,
    // killing the watch — the handler must rewire a fresh structural watcher.
    structural!.emit('all', 'unlinkDir', adminPath);

    await vi.waitFor(() => {
      expect(h.created.length).toBe(createdBefore + 1);
      expect(structural!.closed).toBe(true);
    });
    // The replacement watches .git/HEAD again, so a subsequent worktree add is seen.
    const replacement = h.created[h.created.length - 1];
    expect(Array.isArray(replacement.paths) && replacement.paths.includes(headPath)).toBe(true);
  });

  it('refreshes state after a full re-arm (S3)', async () => {
    await setRepoWatchers([{ path: root, scopeToSubtree: false, isPrimary: true }]);
    h.safeSend.mockClear();

    // A watcher error triggers a one-shot full re-arm.
    const worktree = h.created.find((w) => w.paths === root);
    expect(worktree).toBeDefined();
    worktree!.emit('error', new Error('EMFILE'));

    await vi.waitFor(() => {
      // After re-arm, scalar state is refreshed for the watched path…
      const dirtyEvents = h.safeSend.mock.calls.filter(
        ([, , events]) => Array.isArray(events) && events.some((e) => e.kind === 'repo-dirty'),
      );
      expect(dirtyEvents.length).toBeGreaterThan(0);
      // …and a synthetic structural event is broadcast for the primary.
      const structuralEvents = h.safeSend.mock.calls.filter(
        ([, , events]) =>
          Array.isArray(events) &&
          events.some((e) => e.kind === 'repo-worktrees-changed' && e.repoPath === root),
      );
      expect(structuralEvents.length).toBeGreaterThan(0);
    });
  });

  it('resolves the global excludes file on every watcher build (C3)', async () => {
    await setRepoWatchers([{ path: root, scopeToSubtree: false, isPrimary: true }]);
    const callsAfterFirst = h.execFile.mock.calls.length;

    // Re-arming rebuilds the watcher set and must re-resolve the global excludes
    // file rather than reuse a cached promise.
    const worktree = h.created.find((w) => w.paths === root);
    expect(worktree).toBeDefined();
    worktree!.emit('error', new Error('EMFILE'));

    await vi.waitFor(() => {
      expect(h.execFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });
});

describe('repo-watchers — incremental per-primary re-sync (B4)', () => {
  // Distinct paths (no real FS behind the chokidar mock); the temp `root` is
  // only needed for the global-excludes execFile mock. Self-contained hooks:
  // this describe is a sibling of the M8b one, not a nested child.
  const A = '/repos/primary-a';
  const B = '/repos/primary-b';
  const A_WT1 = '/wt/a-1';
  const A_WT2 = '/wt/a-2';
  const S = '/repos/primary-a/vendor/sub';
  const S_WT1 = '/wt/s-1';
  let root: string;

  beforeEach(async () => {
    h.created.length = 0;
    h.execFile.mockImplementation((_cmd, args, cb) => {
      if (args && args[0] === 'config' && args[1] === '--get' && args[2] === 'core.excludesFile') {
        cb(null, { stdout: join(root, 'global-excludes') });
      } else {
        cb(null, { stdout: '' });
      }
    });
    root = await mkdtemp(join(tmpdir(), 'condash-repo-watchers-b4-'));
  });

  afterEach(async () => {
    await disposeRepoWatchers();
    await rm(root, { recursive: true, force: true });
  });

  /** Minimal RepoEntry — only the fields the watch-target derivation reads. */
  const entry = (
    name: string,
    path: string,
    worktrees: string[] = [],
    parent?: string,
    parentPath?: string,
  ): RepoEntry => ({
    name,
    handle: name,
    path,
    parent,
    parentPath,
    dirty: 0,
    missing: false,
    worktrees: worktrees.map((p) => ({ path: p, branch: 'main', primary: false })),
  });

  it('adds only the new worktree’s watchers on a structural re-sync', async () => {
    await setRepoWatchersForRepos([entry('a', A, [A_WT1]), entry('b', B)]);
    const createdAfterFull = h.created.length;

    await syncRepoWatchersForPrimary([entry('a', A, [A_WT1, A_WT2])]);

    const newWatchers = h.created.slice(createdAfterFull);
    // One new path → exactly its worktree + git-meta watchers, nothing else.
    expect(newWatchers).toHaveLength(2);
    expect(newWatchers.some((w) => w.paths === A_WT2)).toBe(true);
    expect(newWatchers.every((w) => !w.closed)).toBe(true);
    // No pre-existing watcher was torn down or recreated.
    expect(h.created.slice(0, createdAfterFull).every((w) => !w.closed)).toBe(true);
  });

  it('removes only the dropped worktree’s watchers', async () => {
    await setRepoWatchersForRepos([entry('a', A, [A_WT1, A_WT2]), entry('b', B)]);

    await syncRepoWatchersForPrimary([entry('a', A, [A_WT1])]);

    // The a-2 scalar pair is closed…
    expect(h.created.find((w) => w.paths === A_WT2)?.closed).toBe(true);
    const a2GitMeta = h.created.find(
      (w) => Array.isArray(w.paths) && w.paths[0] === join(A_WT2, '.git/index'),
    );
    expect(a2GitMeta?.closed).toBe(true);
    // …while the kept paths’ watchers (both primaries’ roots incl. a’s
    // structural watcher, the surviving worktree) live on untouched.
    expect(h.created.find((w) => w.paths === A)?.closed).toBe(false);
    expect(h.created.find((w) => w.paths === A_WT1)?.closed).toBe(false);
    expect(h.created.find((w) => w.paths === B)?.closed).toBe(false);
  });

  it('rolls a submodule child’s targets into its primary’s slice', async () => {
    await setRepoWatchersForRepos([entry('a', A, [A_WT1]), entry('a/s', S, [], 'a', A)]);
    const createdAfterFull = h.created.length;

    // The structural event fired on primary a; the re-listed entries include
    // the submodule child, whose new worktree must be picked up even though
    // the child is not itself a primary.
    await syncRepoWatchersForPrimary([entry('a', A, [A_WT1]), entry('a/s', S, [S_WT1], 'a', A)]);

    const newWatchers = h.created.slice(createdAfterFull);
    expect(newWatchers).toHaveLength(2); // the submodule worktree’s pair only
    expect(newWatchers.some((w) => w.paths === S_WT1)).toBe(true);
    expect(h.created.slice(0, createdAfterFull).every((w) => !w.closed)).toBe(true);
  });

  it('an unknown primary leaves the watch set alone', async () => {
    await setRepoWatchersForRepos([entry('a', A, [A_WT1]), entry('b', B)]);
    const createdAfterFull = h.created.length;

    await syncRepoWatchersForPrimary([]);

    expect(h.created.length).toBe(createdAfterFull);
    expect(h.created.every((w) => !w.closed)).toBe(true);
  });
});
