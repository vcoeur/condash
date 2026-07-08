/**
 * Per-repo FS watchers that drive Code-pane refresh on two distinct axes:
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
 *   - the worktree root, ignoring **everything git ignores** (via
 *     `gitignore-matcher.ts`) plus a hardcoded floor (`.git`, `.condash`,
 *     `node_modules`, `dist*`, `build*`, `target`) — catches edits that
 *     don't touch the index (axis 1). Driving the ignore set off gitignore
 *     both silences the self-trigger loop (condash writes `.condash/` every
 *     few seconds) and stops chokidar descending into gitignored trees
 *     (`.venv/`, `__pycache__/`), which is what shrinks the inotify set;
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
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { RepoEntry, RepoEvent } from '../shared/types';
import { EVENT_CHANNELS } from '../shared/ipc-channels';
import { safeSend } from './safe-send';
import { reportWatcherError } from './watcher-status';
import { getDirtyCount, getUpstreamStatus, invalidateForPath } from './git-status-cache';
import { buildGitignoreMatcher, readRuleText, type GitignoreMatcher } from './gitignore-matcher';

const execFileAsync = promisify(execFile);

const SCALAR_DEBOUNCE_MS = 500;
const STRUCTURAL_DEBOUNCE_MS = 250;

/** Mutable holder so a `.gitignore` edit can swap in a freshly-built matcher
 *  without tearing down the chokidar watcher — the `ignored` closure reads
 *  `holder.matcher` on every call, so a reassignment takes effect for all
 *  subsequent events/descents. */
interface MatcherHolder {
  matcher: GitignoreMatcher;
}

/** The user's global excludes file (`git config core.excludesFile`), resolved
 *  once for the app lifetime — it is per-user, not per-conception. `null` once
 *  resolved-to-absent. */
let globalExcludesPromise: Promise<string | null> | undefined;

function resolveGlobalExcludesFile(): Promise<string | null> {
  if (!globalExcludesPromise) globalExcludesPromise = computeGlobalExcludesFile();
  return globalExcludesPromise;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve the global excludes file: explicit `core.excludesFile`, else the
 *  XDG default (`$XDG_CONFIG_HOME/git/ignore` → `~/.config/git/ignore`).
 *  Returns null when neither exists — a missing global excludes file is normal. */
async function computeGlobalExcludesFile(): Promise<string | null> {
  let configured: string | null = null;
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', 'core.excludesFile']);
    const trimmed = stdout.trim();
    if (trimmed.length > 0) configured = expandHome(trimmed);
  } catch {
    // git absent, or the key is unset — fall through to the XDG default.
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const fallback = xdg ? join(xdg, 'git', 'ignore') : join(homedir(), '.config', 'git', 'ignore');
  const candidate = configured ?? fallback;
  return existsSync(candidate) ? candidate : null;
}

/** Build a gitignore-backed matcher for one watch root from its rule sources. */
function buildWorktreeMatcher(root: string, globalExcludesFile: string | null): GitignoreMatcher {
  return buildGitignoreMatcher(root, readRuleText(root, globalExcludesFile));
}

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

// The target set most recently passed to `setRepoWatchers`, plus the signature
// of the set we've already spent our one error re-arm on. Re-arm is guarded by
// the signature so a persistent failure (e.g. EMFILE surviving the rebuild)
// can't loop, while a genuinely new repo set gets a fresh attempt (W3a).
let lastRepoTargets: WatchedPath[] = [];
let repoReArmedForSignature: string | null = null;

function targetSetSignature(targets: readonly WatchedPath[]): string {
  return targets
    .map((t) => t.path)
    .sort()
    .join('\n');
}

/** Close every current watcher + pending timer, WITHOUT touching the re-arm
 *  guard. Shared by `disposeRepoWatchers` (which also resets the guard) and the
 *  error re-arm path (which must not, or it would loop). */
async function teardownAllRepoWatchers(): Promise<void> {
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

/** After a chokidar error surfaced to the user, tear down + rebuild the whole
 *  repo-watcher set ONCE per target signature. Synchronous guard set so a burst
 *  of errors across the worktree / git-meta / structural watchers only rebuilds
 *  once (W3a). */
function reArmRepoWatchers(): void {
  const signature = targetSetSignature(lastRepoTargets);
  if (repoReArmedForSignature === signature) return;
  repoReArmedForSignature = signature;
  void teardownAllRepoWatchers()
    .then(() => setRepoWatchers(lastRepoTargets))
    .catch((e) => console.error('[repo-watcher] re-arm failed', e));
}

function broadcast(events: RepoEvent[]): void {
  if (events.length === 0) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSend(win.webContents, EVENT_CHANNELS.repoEvents, events);
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
 *  set. Idempotent across repeated calls with the same set.
 *
 *  Closes are awaited before re-creating watchers so a path that gets
 *  removed and re-added in quick succession (e.g. config edit churn,
 *  rapid structural events) cannot race a stale chokidar instance
 *  against its replacement. */
export async function setRepoWatchers(targets: WatchedPath[]): Promise<void> {
  // Remember the current target set so an error handler can re-arm against it.
  // Deliberately not resetting `repoReArmedForSignature` here — the error
  // re-arm path calls back in with the same targets and must stay guarded.
  lastRepoTargets = targets;
  const wantedKeys = new Set(targets.map((t) => t.path));
  const globalExcludesFile = await resolveGlobalExcludesFile();
  const closing: Promise<void>[] = [];

  for (const [path, entry] of watchers) {
    if (wantedKeys.has(path)) continue;
    closing.push(entry.worktree.close().catch(() => undefined));
    closing.push(entry.gitMeta.close().catch(() => undefined));
    if (entry.structural) closing.push(entry.structural.close().catch(() => undefined));
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

  await Promise.all(closing);

  for (const target of targets) {
    if (watchers.has(target.path)) continue;
    // One matcher per root, held mutably so a `.gitignore` edit can rebuild it.
    const holder: MatcherHolder = {
      matcher: buildWorktreeMatcher(target.path, globalExcludesFile),
    };
    const worktree = chokidar.watch(target.path, {
      // Function form so chokidar also refuses to DESCEND into ignored dirs
      // (that is what shrinks the inotify watch set). `entry.stats` supplies
      // isDirectory during the recursive scan, letting dir-only patterns match.
      ignored: (path, stats) => holder.matcher.ignores(path, stats?.isDirectory()),
      ignoreInitial: true,
      persistent: true,
      depth: 99,
    });
    worktree.on('all', (_event, changedPath) => {
      // A `.gitignore` edit can itself change `git status` output (so it must
      // recompute) AND changes the ignore set (so rebuild the matcher). Already
      // -watched dirs aren't retroactively pruned until the next full re-arm,
      // which is acceptable — new rules still govern every subsequent event.
      if (basename(changedPath) === '.gitignore') {
        holder.matcher = buildWorktreeMatcher(target.path, globalExcludesFile);
      }
      scheduleRecompute(target);
    });
    worktree.on('error', (err) => {
      reportWatcherError(err, `repo ${target.path}`);
      reArmRepoWatchers();
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
      reportWatcherError(err, `repo ${target.path} (git metadata)`);
      reArmRepoWatchers();
    });

    let structural: FSWatcher | undefined;
    if (target.isPrimary) {
      structural = buildStructuralWatcher(target.path);
    }

    watchers.set(target.path, { ...target, worktree, gitMeta, structural });
  }
}

/** Build (or rebuild) the structural FSWatcher for a primary repo.
 *
 *  Watches:
 *
 *    - `.git/HEAD` — primary's branch switch (or detached).
 *    - `.git/worktrees/` — `git worktree add` (subdir created) and
 *      `git worktree remove` (subdir unlinked).
 *
 *  `.git/worktrees/` only exists once at least one extra worktree has
 *  been added. We pre-create it as an empty directory so chokidar can
 *  attach right away — git treats an empty admin dir as "no worktrees"
 *  and re-uses it on the next add. Without the pre-create, the cold-start
 *  case (fresh primary, no worktrees yet) would miss the structural event
 *  for the first add until F5 forces a reload.
 *
 *  **Why rebuilds happen**: `git worktree remove` of the *last* worktree
 *  unlinks `.git/worktrees/` itself, killing the inotify watch beneath
 *  chokidar. Any subsequent `git worktree add` re-creates the directory
 *  but chokidar never reattaches, so the renderer never sees the new
 *  worktree. The `unlinkDir` handler below detects that case and calls
 *  `rewireStructuralWatcher` to swap in a fresh chokidar instance. */
function buildStructuralWatcher(repoPath: string): FSWatcher {
  const headPath = join(repoPath, '.git/HEAD');
  const adminPath = join(repoPath, '.git/worktrees');
  try {
    mkdirSync(adminPath, { recursive: true });
  } catch {
    // best-effort — repo missing, .git is a file (this is itself a
    // worktree, not a primary), or permissions. Fall back to skipping
    // the admin watcher.
  }
  const structuralPaths: string[] = [headPath];
  if (existsSync(adminPath)) structuralPaths.push(adminPath);
  const w = chokidar.watch(structuralPaths, {
    ignoreInitial: true,
    persistent: true,
    depth: 1,
  });
  w.on('all', (event, eventPath) => {
    if (event === 'unlinkDir' && eventPath === adminPath) {
      // The watched admin dir was just deleted (last worktree removed).
      // Re-arm before the renderer reload races us — otherwise the next
      // `git worktree add` will fire to a dead watcher.
      void rewireStructuralWatcher(repoPath);
    }
    scheduleStructural(repoPath);
  });
  w.on('error', (err) => {
    reportWatcherError(err, `repo ${repoPath} (worktrees)`);
    reArmRepoWatchers();
  });
  return w;
}

async function rewireStructuralWatcher(repoPath: string): Promise<void> {
  const entry = watchers.get(repoPath);
  if (!entry || !entry.isPrimary) return;
  const old = entry.structural;
  entry.structural = buildStructuralWatcher(repoPath);
  if (old) await old.close().catch(() => undefined);
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
  const eventTuples = await Promise.all(
    targets.map(async (t) => {
      invalidateForPath(t.path);
      const [dirty, upstream] = await Promise.all([
        getDirtyCount(t.path, t.scopeToSubtree ? { scopeToSubtree: true } : {}),
        getUpstreamStatus(t.path),
      ]);
      return [
        { kind: 'repo-dirty' as const, path: t.path, dirty },
        { kind: 'repo-upstream' as const, path: t.path, upstream },
      ];
    }),
  );
  broadcast(eventTuples.flat());
}

/** Tear down everything. Called on app quit and conception-path change. Resets
 *  the error re-arm guard so the next conception's watcher set gets its own
 *  one-shot re-arm. */
export async function disposeRepoWatchers(): Promise<void> {
  repoReArmedForSignature = null;
  lastRepoTargets = [];
  await teardownAllRepoWatchers();
}
