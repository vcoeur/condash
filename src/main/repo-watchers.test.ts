/**
 * Rebuild-trigger tests for the Code-pane repo watchers (M8b).
 *
 *   - a `.gitignore` change fires the worktree watcher's handler, which must
 *     rebuild the per-root gitignore matcher (so new rules govern subsequent
 *     events / descent);
 *   - `git worktree remove` of the last worktree unlinks `.git/worktrees/`,
 *     killing the inotify watch beneath the structural watcher — the module
 *     must re-arm (rewire) a fresh structural watcher so the next
 *     `git worktree add` is still seen.
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
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { setRepoWatchers, disposeRepoWatchers } from './repo-watchers';

describe('repo-watchers — rebuild triggers (M8b)', () => {
  let root: string;

  beforeEach(async () => {
    h.created.length = 0;
    h.buildGitignoreMatcher.mockClear();
    h.readRuleText.mockClear();
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
});
