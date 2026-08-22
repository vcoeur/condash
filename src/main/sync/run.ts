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
import { touchDirtyMarker } from '../dirty';
import { closeMilestoneSubject, extractClosedEntries } from './close-milestone';
import {
  classifyPath,
  commitGroups,
  INDEX_COMMIT_SUBJECT,
  type CommitGroup,
  type SyncTree,
} from './group';
import {
  behindUpstream,
  commitPaths,
  fetchUpstream,
  ffOnlyMerge,
  inProgressOperation,
  push,
  readChangedPaths,
  readFileAtHead,
  resolveGitDir,
  upstreamAhead,
  type ChangedPath,
} from './git';
import { acquireSyncLock, type LockHolder } from './lock';

const TREES: [tree: SyncTree, strategy: IndexStrategy][] = [
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
  /** ff-only: fetch and fast-forward before pushing when the remote is ahead-only; off: legacy behavior, no fetch/integration. */
  integration: 'off' | 'ff-only';
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
  /** Index regeneration was held back for at least one tree because a path
   *  in *that* tree with no blob in HEAD is still mid-write; the marker stays
   *  set and the next tick where that path is settled does it. True iff
   *  `deferredIndexTrees` is non-empty. */
  indexesDeferred: boolean;
  /** The trees whose pending index work this run deferred. Empty when nothing
   *  was deferred — a tree with an unsettled path but no index work waiting is
   *  not listed, because there is nothing being held up. */
  deferredIndexTrees: SyncTree[];
  /** The mid-write, new-to-HEAD paths that caused the deferral — one per
   *  path, repo-relative, sorted. Empty iff `deferredIndexTrees` is. */
  deferredIndexPaths: string[];
  /** Commits on HEAD that upstream doesn't have after the last check; `null`
   *  when no upstream. */
  ahead: number | null;
  /** Commits on upstream that HEAD doesn't have after the fetch; `null` when
   *  there is no upstream or the integration wasn't attempted. */
  behind: number | null;
  /** True when the fetch found commits on both sides — the push is refused
   *  until a human reconciles with `git pull --rebase`. */
  diverged: boolean;
  pushed: boolean;
  /** Set when the push was rejected. Not fatal — the next run retries. */
  pushError: string | null;
  /** Set when the fetch or the fast-forward failed; the push is skipped.
   *  Not fatal — the next run retries. */
  integrateError: string | null;
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

    const integration = await integrateBeforePush(conceptionPath, options);

    const cutoffMs = Date.now() - options.quietPeriodSeconds * 1000;

    const eligible: string[] = [];
    const skipped: SkippedPath[] = [];
    // Two different facts about a mid-write item/knowledge path, per tree.
    // `unsettledTrees`: something in the tree is still being written, so a
    // bullet the engine derives this tick may describe text no commit will
    // ever hold — that tree's marker must outlive this tick. `heldBackTrees`:
    // the mid-write path has no blob in HEAD, so an index linking it would
    // dangle on `main` — that tree's index work waits. Only the second defers;
    // the first is repaired by re-deriving on a later tick (condash#527). A
    // mid-write `AGENTS.md` (a `meta` path) is never referenced by any index
    // and a mid-write project item is never referenced by a
    // `knowledge/**/index.md`, so each tree is gated on its own paths alone.
    const unsettledTrees = new Set<SyncTree>();
    const heldBackTrees = new Set<SyncTree>();
    const heldBackPaths: string[] = [];
    // Index paths already modified BEFORE this sweep touched anything — i.e.
    // by a hand-run `condash knowledge index` or another external writer.
    // Sync cannot subject its own regenerated indexes to the quiet period,
    // but these pre-existing changes are exactly what the quiet period is
    // for, so they are remembered here and gated below.
    const preExistingIndexChanges = new Set<string>();
    // Trees whose content this sweep commits. Their indexes are regenerated in
    // the same sweep whether or not a marker is set, so an index never trails
    // the content it describes by more than the quiet period — and a deleted
    // body file drops its bullet in the tick that commits the deletion.
    const committingTrees = new Set<SyncTree>();
    for (const { path, newToHead } of changed) {
      const cls = classifyPath(path);
      if (cls.kind === 'index') {
        preExistingIndexChanges.add(path);
        continue;
      }
      if (cls.kind === 'unresolved') {
        skipped.push({ path, reason: 'unresolved' });
        continue;
      }
      const tree: SyncTree | null =
        cls.kind === 'item' ? 'projects' : cls.kind === 'knowledge' ? 'knowledge' : null;
      if (!(await isSettled(join(conceptionPath, path), cutoffMs))) {
        skipped.push({ path, reason: 'quiet-period' });
        if (tree) {
          unsettledTrees.add(tree);
          if (newToHead) {
            heldBackTrees.add(tree);
            heldBackPaths.push(path);
          }
        }
        continue;
      }
      eligible.push(path);
      if (tree) committingTrees.add(tree);
    }

    // An index is fan-in over every item *of its tree*, so regenerating it
    // while a brand-new item is still inside the quiet period would commit a
    // `projects/index.md` whose bullets point at a directory this commit
    // doesn't contain — a dangling reference on `main`, which is worse than
    // the mid-state file commits the quiet period already tolerates. So the
    // index step is deferred (leaving `.index-dirty` set) — per tree, and only
    // for a path HEAD has never held. Gating on *any* unsettled path starved
    // the index bucket: in a conception with parallel sessions some item path
    // is nearly always mid-write (condash#508 across trees, condash#527 within
    // one), so item content committed tick after tick while the indexes
    // describing it never did. A tracked file mid-write is safe to regenerate
    // over: its bullet may describe text one tick stale, and the marker kept
    // below guarantees the next tick re-derives it.
    // Sync itself writes index files during regeneration, so index paths
    // cannot simply be subject to the quiet period — its own writes would
    // never commit. Instead: a candidate index path commits when it was
    // already settled before this sweep (mtime at or before the cutoff), or
    // when the change is NEW since the sweep started (authored by this
    // tick's regeneration). A pre-existing change that is still inside the
    // quiet period — the hand-run index rewrite mid-write — waits for the
    // next tick, like every other path.
    const regeneratedTrees = await regenerateDirtyTrees(conceptionPath, options.dryRun, {
      heldBackTrees,
      forceTrees: committingTrees,
    });

    // A tree regenerated while one of its paths was mid-write may now carry a
    // bullet derived from text that will never be committed as such. Keep the
    // marker set so the next tick re-derives; it clears only on a regeneration
    // that found every path in the tree settled.
    if (!options.dryRun) {
      for (const tree of regeneratedTrees) {
        if (unsettledTrees.has(tree)) await touchDirtyMarker(conceptionPath, tree);
      }
    }

    // Re-read: regeneration just rewrote index.md files. A deferred tree's
    // index.md changes are left uncommitted even when they are already on
    // disk — an agent that ran `condash knowledge index` by hand clears the
    // marker, so the marker alone doesn't cover them.
    const indexPathsByTree = new Map<SyncTree, string[]>();
    for (const { path } of await readChangedPaths(conceptionPath)) {
      const cls = classifyPath(path);
      if (cls.kind !== 'index') continue;
      const bucket = indexPathsByTree.get(cls.tree);
      if (bucket) bucket.push(path);
      else indexPathsByTree.set(cls.tree, [path]);
    }
    const indexPaths: string[] = [];
    for (const [tree, paths] of indexPathsByTree) {
      if (heldBackTrees.has(tree)) continue;
      for (const path of paths) {
        const stat = await fs.stat(join(conceptionPath, path)).catch(() => null);
        const mtimeMs = stat?.mtimeMs ?? 0;
        const settled = mtimeMs <= cutoffMs;
        const syncAuthored = !preExistingIndexChanges.has(path);
        if (settled || syncAuthored) indexPaths.push(path);
        else skipped.push({ path, reason: 'quiet-period' });
      }
    }
    indexPaths.sort();

    // Only a tree with index work actually waiting counts as deferred, so the
    // flag means "a structural inconsistency is sitting uncommitted", not
    // merely "something somewhere is mid-write".
    const deferredIndexTrees: SyncTree[] = [];
    for (const [tree] of TREES) {
      if (!heldBackTrees.has(tree)) continue;
      const pending =
        (indexPathsByTree.get(tree)?.length ?? 0) > 0 ||
        (await exists(join(conceptionPath, tree, '.index-dirty')));
      if (pending) deferredIndexTrees.push(tree);
    }
    const deferredIndexPaths = heldBackPaths
      .filter((path) => {
        const cls = classifyPath(path);
        const tree = cls.kind === 'item' ? 'projects' : 'knowledge';
        return deferredIndexTrees.includes(tree);
      })
      .sort();

    const commits: SyncCommitRecord[] = [];
    for (const group of commitGroups(eligible)) {
      const subject = (await closeSubject(conceptionPath, group)) ?? group.subject;
      commits.push(await record(conceptionPath, group.paths, subject, options.dryRun));
    }
    if (indexPaths.length > 0) {
      commits.push(await record(conceptionPath, indexPaths, INDEX_COMMIT_SUBJECT, options.dryRun));
    }

    return {
      ...(await pushState(conceptionPath, options, integration)),
      commits,
      skipped,
      regeneratedTrees,
      indexesDeferred: deferredIndexTrees.length > 0,
      deferredIndexTrees,
      deferredIndexPaths,
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

      const integration = await integrateBeforePush(conceptionPath, options);

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
        ...(await pushState(conceptionPath, options, integration)),
        commits,
        skipped: [],
        regeneratedTrees: [],
        indexesDeferred: false,
        deferredIndexTrees: [],
        deferredIndexPaths: [],
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
      deferredIndexTrees: [],
      deferredIndexPaths: [],
      ahead: null,
      behind: null,
      diverged: false,
      pushed: false,
      pushError: null,
      integrateError: null,
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

/**
 * Regenerate whichever trees carry a `.index-dirty` sentinel or are named in
 * `forceTrees` (their content commits this sweep), skipping the ones held
 * back. A skipped tree keeps its marker, so the next tick that finds its new
 * paths settled does the work. Regeneration is idempotent — same tree
 * contents, zero diff — so a forced run over an unchanged tree costs a walk
 * and writes nothing.
 */
async function regenerateDirtyTrees(
  conceptionPath: string,
  dryRun: boolean,
  gates: { heldBackTrees: ReadonlySet<SyncTree>; forceTrees: ReadonlySet<SyncTree> },
): Promise<SyncTree[]> {
  const regenerated: SyncTree[] = [];
  for (const [tree, strategy] of TREES) {
    if (gates.heldBackTrees.has(tree)) continue;
    const due =
      gates.forceTrees.has(tree) || (await exists(join(conceptionPath, tree, '.index-dirty')));
    if (!due) continue;
    await regenerateIndex(conceptionPath, strategy, { dryRun });
    regenerated.push(tree);
  }
  return regenerated;
}

/**
 * Milestone subject for an item group whose sweep introduces the README's
 * `Closed.` timeline entry, or `null` to keep the group's `<item>: sync`
 * default. Closing is write-files-only for agents, so the real history line
 * has to come from the sweeper itself.
 */
async function closeSubject(conceptionPath: string, group: CommitGroup): Promise<string | null> {
  // Only an item group carries its own README at projects/<month>/<item>/README.md.
  const readmeRel = group.paths.find((path) => {
    const segments = path.split('/');
    return (
      segments.length === 4 &&
      segments[0] === 'projects' &&
      segments[2] === group.key &&
      segments[3] === 'README.md'
    );
  });
  if (!readmeRel) return null;

  let worktreeText: string;
  try {
    worktreeText = await fs.readFile(join(conceptionPath, readmeRel), 'utf8');
  } catch {
    return null; // README deleted in this sweep — nothing to close.
  }
  const headText = await readFileAtHead(conceptionPath, readmeRel);
  return closeMilestoneSubject(
    group.key,
    extractClosedEntries(headText ?? ''),
    extractClosedEntries(worktreeText),
  );
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

/** The part of a {@link SyncReport} that describes remote integration. */
type Integration = Pick<SyncReport, 'ahead' | 'behind' | 'diverged' | 'integrateError'>;

/**
 * Fetch the remote and fast-forward it when it is ahead-only, so the sweep's
 * own commits keep the push a fast-forward. A genuine divergence is never
 * resolved here: the local commits stay, the push is refused, and the human
 * runs `git pull --rebase` — the sweeper itself must never rebase, because
 * that would rewrite the tree under a live session.
 *
 * Returns `null` when the run won't push (dry-run, `--no-push`, or
 * `autoSync.integration: 'off'`), leaving `pushState` on the legacy
 * reporting path.
 */
async function integrateBeforePush(
  conceptionPath: string,
  options: SyncOptions,
): Promise<Integration | null> {
  if (options.dryRun || !options.push || options.integration === 'off') return null;

  try {
    await fetchUpstream(conceptionPath);
  } catch (err) {
    return {
      ahead: null,
      behind: null,
      diverged: false,
      integrateError: `fetch failed: ${firstLine(err)}`,
    };
  }

  const ahead = await upstreamAhead(conceptionPath);
  const behind = await behindUpstream(conceptionPath);
  if (ahead === null || behind === null) {
    // No upstream configured — nothing to integrate against.
    return { ahead, behind, diverged: false, integrateError: null };
  }

  let resolvedBehind = behind;
  let diverged = false;
  let integrateError: string | null = null;
  if (behind > 0 && ahead === 0) {
    const ff = await ffOnlyMerge(conceptionPath);
    if (!ff.ok) {
      integrateError = `fast-forward failed: ${ff.error}`;
    } else {
      // The remote commits are now on HEAD; the sweep's own commits will keep
      // the push a fast-forward.
      resolvedBehind = 0;
    }
  } else if (behind > 0 && ahead > 0) {
    diverged = true;
  }

  return { ahead, behind: resolvedBehind, diverged, integrateError };
}

/**
 * Push when asked and when there's something to push. A rejected push is
 * recorded, not repaired: `git pull --rebase` would rewrite the tree under a
 * live session, which is the very race sync exists to prevent.
 *
 * With an integration result, a divergence or a failed integration refuses the
 * push outright — the local commits stay and the human reconciles.
 */
async function pushState(
  conceptionPath: string,
  options: SyncOptions,
  integration: Integration | null,
): Promise<
  Pick<SyncReport, 'ahead' | 'behind' | 'diverged' | 'pushed' | 'pushError' | 'integrateError'>
> {
  // Integration not attempted (dry-run, `--no-push`): report only what the
  // branch shows right now.
  if (integration === null) {
    const ahead = await upstreamAhead(conceptionPath);
    if (options.dryRun || !options.push || ahead === null || ahead === 0) {
      return {
        ahead,
        pushed: false,
        pushError: null,
        behind: null,
        diverged: false,
        integrateError: null,
      };
    }
    try {
      await push(conceptionPath);
      return {
        ahead: 0,
        pushed: true,
        pushError: null,
        behind: null,
        diverged: false,
        integrateError: null,
      };
    } catch (err) {
      return {
        ahead,
        pushed: false,
        pushError: err instanceof Error ? err.message : String(err),
        behind: null,
        diverged: false,
        integrateError: null,
      };
    }
  }

  // A divergence or a failed integration refuses the push: the local commits
  // stay and the human runs `git pull --rebase`.
  if (integration.diverged || integration.integrateError) {
    return {
      ahead: integration.ahead,
      behind: integration.behind,
      diverged: integration.diverged,
      integrateError: integration.integrateError,
      pushed: false,
      pushError: null,
    };
  }

  // The integration was clean (remote-only changes fast-forwarded), but the
  // sweep may have committed since — re-count what is actually pushable.
  const ahead = await upstreamAhead(conceptionPath);
  if (!options.dryRun && options.push && ahead !== null && ahead > 0) {
    try {
      await push(conceptionPath);
      return {
        ahead: 0,
        behind: integration.behind,
        diverged: false,
        integrateError: null,
        pushed: true,
        pushError: null,
      };
    } catch (err) {
      return {
        ahead,
        behind: integration.behind,
        diverged: false,
        integrateError: null,
        pushed: false,
        pushError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return {
    ahead: integration.ahead,
    behind: integration.behind,
    diverged: false,
    integrateError: null,
    pushed: false,
    pushError: null,
  };
}

/** First non-empty line of an exec error's stderr/stdout/message. */
function firstLine(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const text = e.stderr ?? e.stdout ?? e.message ?? '';
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? 'unknown error'
  );
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
