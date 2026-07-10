/**
 * The `condash sync` orchestrator — one process, one lock, one commit per item.
 *
 * A conception checkout shared by parallel agent sessions has three ways to
 * corrupt itself: the process-wide `.git/index`, the fan-in `index.md` files
 * that no session owns, and racing pushes. Making exactly one process the
 * committer dissolves all three, so everything below runs inside
 * {@link acquireSyncLock} and nothing else in the tree ever calls git.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { knowledgeStrategy } from '../index-knowledge';
import { projectsStrategy } from '../index-projects';
import { regenerateIndex } from '../index-tree';
import type { IndexStrategy } from '../index-tree';
import { classifyPath, commitGroups, INDEX_COMMIT_SUBJECT } from './group';
import {
  commitPaths,
  inProgressOperation,
  push,
  readChangedPaths,
  resolveGitDir,
  upstreamAhead,
  type ChangedPath,
} from './git';
import { acquireSyncLock, type LockHolder } from './lock';

const TREES: [tree: 'projects' | 'knowledge', strategy: IndexStrategy][] = [
  ['projects', projectsStrategy],
  ['knowledge', knowledgeStrategy],
];

/** Sync refused to run: the tree is mid-merge, conflicted, or already locked. */
export class SyncRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncRefusedError';
  }
}

export interface SyncOptions {
  dryRun: boolean;
  /** Push when the branch ends up ahead of its upstream. */
  push: boolean;
}

export interface SyncRunOptions extends SyncOptions {
  /** Paths modified within this many seconds are left for the next tick. */
  quietPeriodSeconds: number;
}

export interface SyncCommitRecord {
  subject: string;
  /** `null` under `--dry-run`, or when git found nothing to record. */
  sha: string | null;
  paths: string[];
}

export interface SkippedPath {
  path: string;
  reason: 'quiet-period' | 'unresolved';
}

export interface SyncReport {
  /** Another sync held the lock; nothing was done. */
  locked: boolean;
  heldBy: LockHolder | null;
  dryRun: boolean;
  commits: SyncCommitRecord[];
  skipped: SkippedPath[];
  /** Trees whose `.index-dirty` marker triggered a regeneration. */
  regeneratedTrees: string[];
  /** Index regeneration was held back because some item is still mid-write;
   *  the marker stays set and the next settled tick does it. */
  indexesDeferred: boolean;
  /** Commits ahead of upstream after the run; `null` when no upstream. */
  ahead: number | null;
  pushed: boolean;
  /** Set when the push was rejected. Not fatal — the next run retries. */
  pushError: string | null;
}

/**
 * Sweep the conception: commit every settled change, one commit per item,
 * regenerate stale indexes into a commit of their own, then push.
 *
 * @param conceptionPath conception root (a git checkout)
 * @param options quiet period, dry-run, push
 * @returns what was committed, skipped, and pushed
 * @throws SyncRefusedError when the tree is mid-operation or conflicted
 */
export async function syncRun(
  conceptionPath: string,
  options: SyncRunOptions,
): Promise<SyncReport> {
  return withLock(conceptionPath, options.dryRun, async (gitDir) => {
    const changed = await readChangedPaths(conceptionPath);
    await assertOperable(gitDir, changed);

    const cutoffMs = Date.now() - options.quietPeriodSeconds * 1000;

    const eligible: string[] = [];
    const skipped: SkippedPath[] = [];
    // Only an item/knowledge path held back defers the indexes — a mid-write
    // `AGENTS.md` (a `meta` path) is never referenced by a regenerated index.
    let treePathHeldBack = false;
    for (const { path } of changed) {
      const cls = classifyPath(path);
      if (cls.kind === 'index') continue;
      if (cls.kind === 'unresolved') {
        skipped.push({ path, reason: 'unresolved' });
        continue;
      }
      if (!(await isSettled(join(conceptionPath, path), cutoffMs))) {
        skipped.push({ path, reason: 'quiet-period' });
        if (cls.kind === 'item' || cls.kind === 'knowledge') treePathHeldBack = true;
        continue;
      }
      eligible.push(path);
    }

    // An index is fan-in over *every* item, so regenerating it while some item
    // is still inside the quiet period would commit a `projects/index.md` whose
    // bullets point at directories this commit doesn't contain — a dangling
    // reference on `main`, which is worse than the mid-state file commits the
    // quiet period already tolerates. Defer the whole index step (leaving
    // `.index-dirty` set) until a tick finds the tree settled.
    const indexesDeferred = treePathHeldBack;

    const regeneratedTrees = indexesDeferred
      ? []
      : await regenerateDirtyTrees(conceptionPath, options.dryRun);

    // Re-read: regeneration just rewrote index.md files, and they are exempt
    // from the quiet period precisely because sync itself set their mtime.
    const indexPaths = indexesDeferred
      ? []
      : (await readChangedPaths(conceptionPath))
          .filter(({ path }) => classifyPath(path).kind === 'index')
          .map(({ path }) => path)
          .sort();

    const commits: SyncCommitRecord[] = [];
    for (const group of commitGroups(eligible)) {
      commits.push(await record(conceptionPath, group.paths, group.subject, options.dryRun));
    }
    if (indexPaths.length > 0) {
      commits.push(await record(conceptionPath, indexPaths, INDEX_COMMIT_SUBJECT, options.dryRun));
    }

    return {
      ...(await pushState(conceptionPath, options)),
      commits,
      skipped,
      regeneratedTrees,
      indexesDeferred,
    };
  });
}

/**
 * Commit one item's changes under a real subject line, taking the same lock so
 * a milestone can't interleave with the sweeper. No quiet period: the caller
 * is explicit about what they're committing.
 *
 * @param conceptionPath conception root
 * @param itemRelPath repo-relative item dir, e.g. `projects/2026-07/2026-07-10-foo`
 * @param message commit subject
 * @param options dry-run, push
 * @throws SyncRefusedError when locked, mid-operation, or the item has no changes
 */
export async function syncCommit(
  conceptionPath: string,
  itemRelPath: string,
  message: string,
  options: SyncOptions,
): Promise<SyncReport> {
  return withLock(
    conceptionPath,
    options.dryRun,
    async (gitDir) => {
      const changed = await readChangedPaths(conceptionPath);
      await assertOperable(gitDir, changed);

      const prefix = `${itemRelPath}/`;
      const paths = changed
        .map(({ path }) => path)
        .filter((path) => path.startsWith(prefix))
        .sort();
      if (paths.length === 0) {
        throw new SyncRefusedError(`No changes under ${itemRelPath}`);
      }

      const commits = [await record(conceptionPath, paths, message, options.dryRun)];
      return {
        ...(await pushState(conceptionPath, options)),
        commits,
        skipped: [],
        regeneratedTrees: [],
        indexesDeferred: false,
      };
    },
    { silentWhenLocked: false },
  );
}

/**
 * Run `body` under the sync lock, returning a `locked: true` report instead
 * when another process holds it.
 *
 * `sync run` is timer-driven, so a held lock is a no-op it reports and exits
 * 0 on. `sync commit` is a human milestone, so a held lock is an error worth
 * seeing.
 */
async function withLock(
  conceptionPath: string,
  dryRun: boolean,
  body: (gitDir: string) => Promise<Omit<SyncReport, 'locked' | 'heldBy' | 'dryRun'>>,
  { silentWhenLocked = true }: { silentWhenLocked?: boolean } = {},
): Promise<SyncReport> {
  const gitDir = await resolveGitDir(conceptionPath);
  const acquired = await acquireSyncLock(gitDir);
  if (!acquired.acquired) {
    if (!silentWhenLocked) {
      const who = acquired.heldBy ? ` (pid ${acquired.heldBy.pid})` : '';
      throw new SyncRefusedError(`Another condash sync holds the lock${who}`);
    }
    return {
      locked: true,
      heldBy: acquired.heldBy,
      dryRun,
      commits: [],
      skipped: [],
      regeneratedTrees: [],
      indexesDeferred: false,
      ahead: null,
      pushed: false,
      pushError: null,
    };
  }
  try {
    const rest = await body(gitDir);
    return { locked: false, heldBy: null, dryRun, ...rest };
  } finally {
    await acquired.lock.release();
  }
}

async function assertOperable(gitDir: string, changed: readonly ChangedPath[]): Promise<void> {
  const operation = await inProgressOperation(gitDir);
  if (operation) {
    throw new SyncRefusedError(`Refusing to sync: ${operation} is in progress`);
  }
  const conflicted = changed.filter((c) => c.conflicted);
  if (conflicted.length > 0) {
    const names = conflicted
      .slice(0, 3)
      .map((c) => c.path)
      .join(', ');
    const more = conflicted.length > 3 ? ` (+${conflicted.length - 3} more)` : '';
    throw new SyncRefusedError(`Refusing to sync: conflicted paths — ${names}${more}`);
  }
}

/** Regenerate whichever trees carry a `.index-dirty` sentinel. */
async function regenerateDirtyTrees(conceptionPath: string, dryRun: boolean): Promise<string[]> {
  const regenerated: string[] = [];
  for (const [tree, strategy] of TREES) {
    if (!(await exists(join(conceptionPath, tree, '.index-dirty')))) continue;
    await regenerateIndex(conceptionPath, strategy, { dryRun });
    regenerated.push(tree);
  }
  return regenerated;
}

async function record(
  conceptionPath: string,
  paths: string[],
  subject: string,
  dryRun: boolean,
): Promise<SyncCommitRecord> {
  const sha = dryRun ? null : await commitPaths(conceptionPath, paths, subject);
  return { subject, sha, paths };
}

/**
 * Push when asked and when there's something to push. A rejected push is
 * recorded, not repaired: `git pull --rebase` would rewrite the tree under a
 * live session, which is the very race sync exists to prevent.
 */
async function pushState(
  conceptionPath: string,
  options: SyncOptions,
): Promise<Pick<SyncReport, 'ahead' | 'pushed' | 'pushError'>> {
  const ahead = await upstreamAhead(conceptionPath);
  if (options.dryRun || !options.push || ahead === null || ahead === 0) {
    return { ahead, pushed: false, pushError: null };
  }
  try {
    await push(conceptionPath);
    return { ahead: 0, pushed: true, pushError: null };
  } catch (err) {
    return { ahead, pushed: false, pushError: err instanceof Error ? err.message : String(err) };
  }
}

/** A path older than the cutoff — or gone entirely — is safe to commit. */
async function isSettled(absPath: string, cutoffMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    return stat.mtimeMs <= cutoffMs;
  } catch (err) {
    // Deleted: no mtime to compare, so the quiet period cannot apply.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
