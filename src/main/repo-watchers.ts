/**
 * Per-repo FS watchers that drive in-place dirty-count + upstream-state
 * updates on the Code tab. One pair of chokidar watchers per repo working
 * tree:
 *
 *   - the worktree root, ignoring `.git/`, `node_modules/`, `dist*`
 *     and `build*` directories — catches edits that don't touch the index;
 *   - `.git/index`, `.git/HEAD`, `.git/refs/heads/`, `.git/refs/remotes/`,
 *     `.git/packed-refs`, `.git/FETCH_HEAD`, `.git/config` — catches
 *     stage, unstage, checkout, branch-create operations, and (the new
 *     paths) push, fetch, set-upstream so the upstream badge tracks
 *     reality without F5.
 *
 * Events from either watcher debounce to a single recompute per path.
 * The recompute reuses `getDirtyCount` / `getUpstreamStatus` (and their
 * TTL caches) so a burst of writes coalesces to one git invocation each.
 *
 * The output is a typed `RepoEvent` broadcast to every BrowserWindow.
 * The renderer's `applyRepoEvents` patches `RepoEntry.dirty` (or a
 * worktree's `dirty` / `upstream`) in place, leaving everything else —
 * open dropdowns, popovers, focus, scroll position — untouched. This is
 * the direct fix for the disruption the periodic 15 s refreshKey-bump
 * approach (reverted in commit 0c36e2b) caused.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { RepoEntry, RepoEvent } from '../shared/types';
import { getDirtyCount, getUpstreamStatus, invalidateForPath } from './git-status-cache';

const DEBOUNCE_MS = 500;

const WORKTREE_IGNORED = [
  /(^|[/\\])\.git([/\\]|$)/,
  /(^|[/\\])node_modules([/\\]|$)/,
  /(^|[/\\])dist[^/\\]*([/\\]|$)/,
  /(^|[/\\])build[^/\\]*([/\\]|$)/,
  /(^|[/\\])target([/\\]|$)/,
];

interface WatchedPath {
  path: string;
  /** True when the underlying repo is a submodule sharing its parent's
   *  `.git` directory — `getDirtyCount` then needs `-- .` scoping. */
  scopeToSubtree: boolean;
}

interface WatcherEntry extends WatchedPath {
  worktree: FSWatcher;
  gitMeta: FSWatcher;
}

const watchers = new Map<string, WatcherEntry>();
const pendingTimers = new Map<string, NodeJS.Timeout>();

function broadcast(events: RepoEvent[]): void {
  if (events.length === 0) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('repo-events', events);
  }
}

async function recomputeAndEmit(target: WatchedPath): Promise<void> {
  invalidateForPath(target.path);
  // Run dirty + upstream in parallel — they hit different git plumbing
  // commands and don't share state. Both broadcasts go out together so
  // the renderer patches once, not twice.
  const [dirty, upstream] = await Promise.all([
    getDirtyCount(target.path, target.scopeToSubtree ? { scopeToSubtree: true } : {}),
    getUpstreamStatus(target.path),
  ]);
  broadcast([
    { kind: 'repo-dirty', path: target.path, dirty },
    { kind: 'repo-upstream', path: target.path, upstream },
  ]);
}

function scheduleRecompute(target: WatchedPath): void {
  const existing = pendingTimers.get(target.path);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingTimers.delete(target.path);
    void recomputeAndEmit(target);
  }, DEBOUNCE_MS);
  pendingTimers.set(target.path, t);
}

/** Replace the watcher set with watchers for the given paths. Watchers
 *  for paths no longer present are torn down; new paths get a fresh
 *  pair. Idempotent across repeated calls with the same set. */
export function setRepoWatchers(targets: WatchedPath[]): void {
  const wantedKeys = new Set(targets.map((t) => t.path));

  for (const [path, entry] of watchers) {
    if (wantedKeys.has(path)) continue;
    void entry.worktree.close().catch(() => undefined);
    void entry.gitMeta.close().catch(() => undefined);
    watchers.delete(path);
    const t = pendingTimers.get(path);
    if (t) {
      clearTimeout(t);
      pendingTimers.delete(path);
    }
  }

  for (const target of targets) {
    if (watchers.has(target.path)) continue;
    const worktree = chokidar.watch(target.path, {
      ignored: WORKTREE_IGNORED,
      ignoreInitial: true,
      persistent: true,
      depth: 99,
    });
    worktree.on('all', () => scheduleRecompute(target));
    worktree.on('error', (err) => {
      console.error(`[repo-watcher] worktree ${target.path}:`, err);
    });

    const gitMeta = chokidar.watch(
      [
        join(target.path, '.git/index'),
        join(target.path, '.git/HEAD'),
        join(target.path, '.git/refs/heads'),
        // Upstream-tracking signals: push writes refs/remotes/<remote>/<branch>
        // (plus packed-refs after gc); fetch additionally touches FETCH_HEAD;
        // set-upstream/unset-upstream rewrites .git/config.
        join(target.path, '.git/refs/remotes'),
        join(target.path, '.git/packed-refs'),
        join(target.path, '.git/FETCH_HEAD'),
        join(target.path, '.git/config'),
      ],
      { ignoreInitial: true, persistent: true },
    );
    gitMeta.on('all', () => scheduleRecompute(target));
    gitMeta.on('error', (err) => {
      console.error(`[repo-watcher] git-meta ${target.path}:`, err);
    });

    watchers.set(target.path, { ...target, worktree, gitMeta });
  }
}

/** Derive the watch list from a `listRepos` result. Each repo and its
 *  worktrees become separate entries; submodule repos inherit the
 *  subtree-scope flag. Missing repos are skipped. */
export function watchTargetsFromRepos(repos: readonly RepoEntry[]): WatchedPath[] {
  const out: WatchedPath[] = [];
  const seen = new Set<string>();
  for (const repo of repos) {
    if (repo.missing) continue;
    const scopeToSubtree = !!repo.parent;
    if (!seen.has(repo.path)) {
      out.push({ path: repo.path, scopeToSubtree });
      seen.add(repo.path);
    }
    if (!repo.worktrees) continue;
    for (const wt of repo.worktrees) {
      if (seen.has(wt.path)) continue;
      out.push({ path: wt.path, scopeToSubtree });
      seen.add(wt.path);
    }
  }
  return out;
}

/** Recompute dirty + upstream for every currently-watched path and
 *  broadcast. Called from the F5 Refresh path so the user gets fresh
 *  counts immediately without waiting for an FS event. */
export async function recomputeAllWatchedRepos(): Promise<void> {
  const targets = [...watchers.values()].map(({ path, scopeToSubtree }) => ({
    path,
    scopeToSubtree,
  }));
  if (targets.length === 0) return;
  const events: RepoEvent[] = [];
  await Promise.all(
    targets.map(async (t) => {
      invalidateForPath(t.path);
      const [dirty, upstream] = await Promise.all([
        getDirtyCount(t.path, t.scopeToSubtree ? { scopeToSubtree: true } : {}),
        getUpstreamStatus(t.path),
      ]);
      events.push({ kind: 'repo-dirty', path: t.path, dirty });
      events.push({ kind: 'repo-upstream', path: t.path, upstream });
    }),
  );
  broadcast(events);
}

/** Tear down everything. Called on app quit and conception-path change. */
export async function disposeRepoWatchers(): Promise<void> {
  const closing: Promise<void>[] = [];
  for (const entry of watchers.values()) {
    closing.push(entry.worktree.close().catch(() => undefined));
    closing.push(entry.gitMeta.close().catch(() => undefined));
  }
  watchers.clear();
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
  await Promise.all(closing);
}
