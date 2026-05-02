/**
 * Per-repo FS watchers that drive Code-tab refresh on two distinct axes:
 *
 *   1. **Scalar push**: dirty-count and upstream-status changes flow as
 *      typed `repo-dirty` / `repo-upstream` events. The renderer patches
 *      one cell in place via path-shaped `setRepos(...)`. Open dropdowns
 *      and popovers stay alive across the patch.
 *
 *   2. **Set-membership reload** (new in v2.10.1): worktree add/remove or
 *      a primary checkout's branch switch fires a `repo-worktrees-changed`
 *      event. The renderer responds with a per-primary `listReposForPrimary`
 *      reload — full row replacement keyed on `path`, so popovers still
 *      survive thanks to the reconcile-with-key contract on the renderer.
 *
 * Watchers per repo working tree:
 *
 *   - the worktree root, ignoring `.git/`, `node_modules/`, `dist*`,
 *     `build*`, `target/` — catches edits that don't touch the index
 *     (axis 1);
 *   - `.git/index`, `.git/refs/heads/`, `.git/refs/remotes/`,
 *     `.git/packed-refs`, `.git/FETCH_HEAD`, `.git/config` — catches
 *     stage, unstage, branch-create, push, fetch, set-upstream
 *     operations (axis 1);
 *   - **structural** (primary repos only): `.git/HEAD` and
 *     `.git/worktrees/` — catches `git checkout` of a branch on the
 *     primary, and `git worktree add/remove` (axis 2).
 *
 * Events from the scalar watchers debounce per-path (500 ms) to one
 * recompute per path. The structural watcher debounces per-primary
 * (250 ms) to one event broadcast per repo.
 *
 * The recompute reuses `getDirtyCount` / `getUpstreamStatus` (and their
 * TTL caches) so a burst of writes coalesces to one git invocation each.
 *
 * Reasoning for the scalar/structural split: scalar events are
 * cell-level patches (cheap, ubiquitous — fire on every keystroke).
 * Structural events trigger a full per-primary re-list which re-runs
 * `git worktree list` and rebuilds the worktree array — too expensive
 * to fire on every commit. Keeping them on different watchers + paths
 * means a commit doesn't pay the structural cost. The original v2.7
 * regression that the v2.8.0 commit (0c36e2b) fixed was exactly this:
 * a single hammer was used for both axes.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoEntry, RepoEvent } from '../shared/types';
import { getDirtyCount, getUpstreamStatus, invalidateForPath } from './git-status-cache';

const SCALAR_DEBOUNCE_MS = 500;
const STRUCTURAL_DEBOUNCE_MS = 250;

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
  /** True for the top-level (primary) `RepoEntry.path` of a repo with its
   *  own `.git` dir. Drives the structural watcher (`.git/HEAD` +
   *  `.git/worktrees/`) which only makes sense for primaries. */
  isPrimary: boolean;
}

interface WatcherEntry extends WatchedPath {
  worktree: FSWatcher;
  gitMeta: FSWatcher;
  /** Only present for primaries — watches `.git/HEAD` + `.git/worktrees`. */
  structural?: FSWatcher;
}

const watchers = new Map<string, WatcherEntry>();
const pendingScalarTimers = new Map<string, NodeJS.Timeout>();
const pendingStructuralTimers = new Map<string, NodeJS.Timeout>();

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
  const existing = pendingScalarTimers.get(target.path);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingScalarTimers.delete(target.path);
    void recomputeAndEmit(target);
  }, SCALAR_DEBOUNCE_MS);
  pendingScalarTimers.set(target.path, t);
}

function emitStructural(repoPath: string): void {
  broadcast([{ kind: 'repo-worktrees-changed', repoPath }]);
}

function scheduleStructural(repoPath: string): void {
  const existing = pendingStructuralTimers.get(repoPath);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingStructuralTimers.delete(repoPath);
    emitStructural(repoPath);
  }, STRUCTURAL_DEBOUNCE_MS);
  pendingStructuralTimers.set(repoPath, t);
}

/** Replace the watcher set with watchers for the given paths. Watchers
 *  for paths no longer present are torn down; new paths get a fresh
 *  set. Idempotent across repeated calls with the same set. */
export function setRepoWatchers(targets: WatchedPath[]): void {
  const wantedKeys = new Set(targets.map((t) => t.path));

  for (const [path, entry] of watchers) {
    if (wantedKeys.has(path)) continue;
    void entry.worktree.close().catch(() => undefined);
    void entry.gitMeta.close().catch(() => undefined);
    if (entry.structural) void entry.structural.close().catch(() => undefined);
    watchers.delete(path);
    const t = pendingScalarTimers.get(path);
    if (t) {
      clearTimeout(t);
      pendingScalarTimers.delete(path);
    }
    const s = pendingStructuralTimers.get(path);
    if (s) {
      clearTimeout(s);
      pendingStructuralTimers.delete(path);
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

    let structural: FSWatcher | undefined;
    if (target.isPrimary) {
      // `.git/HEAD` writes when the primary's checkout switches branch
      // (or goes detached). `.git/worktrees/` directory contents change
      // on `git worktree add` (admin dir created) and `git worktree
      // remove` (admin dir unlinked). Either way, the primary's
      // worktree list as seen by `git worktree list` has changed and
      // the renderer needs a per-primary reload.
      //
      // `.git/worktrees/` only exists once the user has added at least
      // one extra worktree. Pre-create it as an empty dir so chokidar
      // can attach a watcher right away — git treats an empty admin
      // dir as no worktrees, and re-creates it as needed on the first
      // `git worktree add`. Without this, the cold-start case (fresh
      // primary, no worktrees yet) would miss the structural event for
      // the first add until F5 forces a reload.
      const headPath = join(target.path, '.git/HEAD');
      const adminPath = join(target.path, '.git/worktrees');
      try {
        mkdirSync(adminPath, { recursive: true });
      } catch {
        // best-effort — repo missing, .git is a file (this is itself a
        // worktree, not a primary), or permissions. Fall back to
        // skipping the admin watcher.
      }
      const structuralPaths: string[] = [headPath];
      if (existsSync(adminPath)) structuralPaths.push(adminPath);
      structural = chokidar.watch(structuralPaths, {
        ignoreInitial: true,
        persistent: true,
        depth: 1,
      });
      const repoPath = target.path;
      structural.on('all', () => scheduleStructural(repoPath));
      structural.on('error', (err) => {
        console.error(`[repo-watcher] structural ${target.path}:`, err);
      });
    }

    watchers.set(target.path, { ...target, worktree, gitMeta, structural });
  }
}

/** Derive the watch list from a `listRepos` result. Each repo and its
 *  worktrees become separate entries; submodule repos inherit the
 *  subtree-scope flag. Missing repos are skipped. Top-level repos
 *  (`!parent`) carry `isPrimary: true` so the structural watcher spins
 *  up; submodules and per-worktree paths get scalar watchers only. */
export function watchTargetsFromRepos(repos: readonly RepoEntry[]): WatchedPath[] {
  const out: WatchedPath[] = [];
  const seen = new Set<string>();
  for (const repo of repos) {
    if (repo.missing) continue;
    const scopeToSubtree = !!repo.parent;
    const isPrimary = !repo.parent;
    if (!seen.has(repo.path)) {
      out.push({ path: repo.path, scopeToSubtree, isPrimary });
      seen.add(repo.path);
    }
    if (!repo.worktrees) continue;
    for (const wt of repo.worktrees) {
      if (seen.has(wt.path)) continue;
      // Worktree-only paths never need the structural watcher — their
      // .git is a *file* pointing at the primary's `.git/worktrees/<name>/`.
      // The primary is already covered upstream.
      out.push({ path: wt.path, scopeToSubtree, isPrimary: false });
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
    if (entry.structural) closing.push(entry.structural.close().catch(() => undefined));
  }
  watchers.clear();
  for (const t of pendingScalarTimers.values()) clearTimeout(t);
  pendingScalarTimers.clear();
  for (const t of pendingStructuralTimers.values()) clearTimeout(t);
  pendingStructuralTimers.clear();
  await Promise.all(closing);
}
