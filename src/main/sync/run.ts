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
import { basename, dirname, join, relative, resolve } from 'node:path';
import { knowledgeStrategy } from '../index-knowledge';
import { projectsStrategy } from '../index-projects';
import {
  regenerateIndex,
  enumerateIndexPaths,
  retainRecoveryIndexDirtyMarker,
} from '../index-tree';
import type {
  IndexStrategy,
  IndexRecoveryLifecycle,
  IndexRecoveryInput,
  IndexDirectoryReader,
} from '../index-tree';
import { exec } from '../exec';
import { touchDirtyMarker } from '../dirty';
import { closeMilestoneSubject, extractClosedEntries } from './close-milestone';
import {
  classifyPath,
  commitGroups,
  detectRenamePairs,
  INDEX_COMMIT_SUBJECT,
  type CommitGroup,
  type RenamePair,
  type SyncTree,
} from './group';
import {
  behindUpstream,
  commitPaths,
  fetchUpstream,
  ffOnlyMerge,
  formatGitDiagnostic,
  inProgressOperation,
  push,
  readChangedPaths,
  readFileAtHead,
  resolveGitDir,
  upstreamAhead,
  readSyncIncomingChanges,
  readRecoveryChanges,
  readRecoveryDirectory,
  readRecoveryGitState,
  readRecoveryBlob,
  assertRecoveryGitState,
  assertRecoveryFastForward,
  proveInertRecoveryOutputs,
  assertRecoveryAttributeProof,
  verifyRecoveryOutputObjects,
  verifyRecoveryCommitTree,
  type RecoveryGitState,
  type RecoveryGitChange,
  type RecoveryDirectoryEntry,
  type RecoveryAttributeProof,
  type ChangedPath,
} from './git';
import {
  acquireSyncLock,
  inspectRecoveryEvidence,
  promoteSyncLock,
  type LockHolder,
  type SyncLock,
} from './lock';
import {
  readRecoveryManifest,
  RecoveryJournal,
  RecoveryBudget,
  RECOVERY_LIMITS,
  selectRecoveryCandidatePaths,
  validateRecoveryInput,
  observeRecoveryFile,
  assertRecoveryRequirements,
  assertRecoveryJournalPreconditions,
  prepareRecoveryJournalBootstrap,
  recoveryCandidateQualifies,
  type RecoveryPersistenceHooks,
} from './index-recovery';
import { safeMerge } from './safe-merge';

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
  /** ff-only (default), opt-in safe-merge recovery, or off (no fetch/integration). */
  integration: 'off' | 'ff-only' | 'safe-merge';
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
  /** True when histories remain diverged after any permitted recovery; push is refused. */
  diverged: boolean;
  pushed: boolean;
  /** Set when the push was rejected. Not fatal — the next run retries. */
  pushError: string | null;
  /** Integration/recovery failure or post-publication cleanup uncertainty; actual effects remain in the report. */
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
  hooks?: RecoveryPersistenceHooks,
): Promise<SyncReport> {
  assertSyncRootEnvironment();
  const gitDir = await resolveGitDir(conceptionPath);
  const evidence = await inspectRecoveryEvidence(gitDir);
  if (
    evidence.length === 1 &&
    evidence[0].path === join(gitDir, 'condash-index-recovery', 'active') &&
    evidence[0].phase === 'deferred'
  ) {
    let journal: RecoveryJournal;
    try {
      if (
        options.dryRun ||
        !options.push ||
        options.integration === 'off' ||
        !Number.isFinite(options.quietPeriodSeconds) ||
        options.quietPeriodSeconds < 0
      )
        throw new Error('Deferred recovery invocation is not permitted');
      const record = await readRecoveryManifest(evidence[0].path);
      journal = await RecoveryJournal.claim({
        root: conceptionPath,
        gitDir,
        generation: record.generation,
        invocation: {
          kind: 'syncRun',
          dryRun: false,
          push: true,
          integration: options.integration,
          quietPeriodSeconds: options.quietPeriodSeconds,
        },
        hooks,
      });
    } catch (error) {
      throw new SyncRefusedError(
        formatGitDiagnostic(
          `Unresolved index recovery; manual reconciliation required. Evidence=${JSON.stringify(evidence[0].path)} ${formatGitDiagnostic(error)}`,
        ),
      );
    }
    return {
      locked: false,
      heldBy: null,
      dryRun: options.dryRun,
      ...(await sweep(conceptionPath, options, gitDir, null, hooks, journal)),
    };
  }
  return withLock(conceptionPath, options.dryRun, (directory, lock, transferred) =>
    sweep(conceptionPath, options, directory, lock, hooks, undefined, transferred),
  );
}

async function sweep(
  conceptionPath: string,
  options: SyncRunOptions,
  gitDir: string,
  lock: SyncLock | null,
  hooks?: RecoveryPersistenceHooks,
  resumed?: RecoveryJournal,
  transferred?: () => void,
): Promise<Omit<SyncReport, 'locked' | 'heldBy' | 'dryRun'>> {
  let recovery: RecoveryRun | null = resumed ? recoveryRun(conceptionPath, resumed) : null;
  let recoverySelected = !!resumed;
  let recoveryBlockers: string[] = [];
  try {
    let changed = await readChangedPaths(conceptionPath);
    await assertOperable(gitDir, changed);

    const indexMtimes = new Map<string, number>();
    await captureIndexMtimes(conceptionPath, changed, indexMtimes);
    const cutoffMs =
      resumed?.snapshot().invocation.cutoffMs ?? Date.now() - options.quietPeriodSeconds * 1000;
    const integration = resumed
      ? {
          ahead: await upstreamAhead(conceptionPath),
          behind: 0,
          diverged: false,
          integrateError: null,
        }
      : await integrateBeforePush(conceptionPath, options, async () => {
          const local = await readChangedPaths(conceptionPath);
          if (!local.length) return false;
          const incoming = await readSyncIncomingChanges(conceptionPath, RECOVERY_GIT_LIMITS);
          if (!hasGeneratedOverlap(local, incoming.changes)) return false;
          recoverySelected = true;
          recoveryBlockers = local
            .filter(
              (path) =>
                /^(projects|knowledge)\//.test(path.path) && basename(path.path) === 'index.md',
            )
            .slice(0, 3)
            .map((path) => path.path);
          if (!lock) throw new Error('Recovery lacks the ordinary owner token');
          recovery = await prepareRecoveryRun(
            conceptionPath,
            gitDir,
            lock,
            options,
            cutoffMs,
            local,
            incoming,
            hooks,
            (context) => {
              recovery = context;
              transferred?.();
            },
            () => transferred?.(),
          );
          await recoveryFastForward(recovery);
          return true;
        });
    if (integration?.integrateError)
      return integrationFailure(conceptionPath, options, integration);
    changed = await readChangedPaths(conceptionPath);
    if (!recovery) await captureIndexMtimes(conceptionPath, changed, indexMtimes);

    // A detected rename is ONE logical change: the old paths are all deleted
    // (settled by definition — no mtime to compare), the new ones sit out the
    // quiet period like any fresh write. Left to the plain loop the deletion
    // would commit this tick and the addition the next, breaking
    // `git log --follow`; instead both sides commit together under the NEW
    // item's subject (see the pairing block after the loop).
    const renamePairs: RenamePair[] = detectRenamePairs(changed);
    const pairedPaths = new Set<string>(
      renamePairs.flatMap((pair) => [...pair.oldPaths, ...pair.newPaths]),
    );
    const itemAliases = new Map(renamePairs.map((pair) => [pair.oldItem, pair.newItem]));

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
    // Trees whose content this sweep commits. Their indexes are regenerated in
    // the same sweep whether or not a marker is set, so an index never trails
    // the content it describes by more than the quiet period — and a deleted
    // body file drops its bullet in the tick that commits the deletion.
    const committingTrees = new Set<SyncTree>();
    for (const { path, newToHead } of changed) {
      if (pairedPaths.has(path)) continue; // handled with its rename partner
      const cls = classifyPath(path);
      if (cls.kind === 'index') {
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

    // The rename pairs commit as one unit: settled → both sides go eligible
    // (commitGroups merges them under the new item's subject via the alias
    // map); unsettled → BOTH sides wait out the quiet period together, the
    // deletions included — committing a bare deletion now is exactly the
    // two-commit split this exists to prevent.
    for (const pair of renamePairs) {
      const settled = await pathsSettled(conceptionPath, pair.newPaths, cutoffMs);
      if (!settled) {
        for (const path of [...pair.oldPaths, ...pair.newPaths]) {
          skipped.push({ path, reason: 'quiet-period' });
        }
        unsettledTrees.add('projects');
        heldBackTrees.add('projects');
        heldBackPaths.push(...pair.newPaths);
        continue;
      }
      eligible.push(...pair.oldPaths, ...pair.newPaths);
      committingTrees.add('projects');
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
    // Recheck before our own writes, so an observable later editor write stays warm.
    if (!recovery)
      await captureIndexMtimes(conceptionPath, await readChangedPaths(conceptionPath), indexMtimes);
    if (recovery) {
      await refreshRecoveryPaths(recovery);
      for (const path of recovery.journal.snapshot().paths)
        if (path.candidate) committingTrees.add(path.protection.path.split('/')[0] as SyncTree);
    }
    const regeneratedTrees = await regenerateDirtyTrees(
      conceptionPath,
      options.dryRun,
      {
        heldBackTrees,
        forceTrees: committingTrees,
      },
      recovery?.lifecycle,
    );
    if (recovery) recovery.regeneratedTrees = regeneratedTrees;
    // A tracked mid-write source may have contributed a transient row;
    // keep its marker so the next tick derives it again.
    if (!options.dryRun) {
      for (const tree of regeneratedTrees) {
        if (unsettledTrees.has(tree)) {
          if (recovery)
            await retainRecoveryIndexDirtyMarker(
              conceptionPath,
              tree as SyncTree,
              recovery.lifecycle,
            );
          else await touchDirtyMarker(conceptionPath, tree);
        }
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
    if (recovery) await recoveryCheckpoint(recovery);
    for (const [tree, paths] of indexPathsByTree) {
      if (heldBackTrees.has(tree)) continue;
      for (const path of paths) {
        const retained = recovery?.journal
          .snapshot()
          .paths.find((entry) => entry.protection.path === path);
        const mtimeMs = retained ? retained.eligibleAtMs : (indexMtimes.get(path) ?? 0);
        const settled = mtimeMs <= cutoffMs;
        const syncAuthored = retained ? !retained.original.identity : !indexMtimes.has(path);
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

    if (recovery) {
      const warm = recovery.journal
        .snapshot()
        .paths.filter(
          (path) =>
            path.protection.role === 'output' &&
            path.original.identity &&
            path.eligibleAtMs > cutoffMs,
        );
      if (heldBackTrees.size || warm.length) {
        const deferredTrees = [
          ...new Set([
            ...deferredIndexTrees,
            ...warm.map((path) => path.protection.path.split('/')[0] as SyncTree),
            ...heldBackTrees,
          ]),
        ];
        for (const tree of deferredTrees)
          await retainRecoveryIndexDirtyMarker(conceptionPath, tree, recovery.lifecycle);
        const deferredAhead = await upstreamAhead(conceptionPath);
        await recovery.journal.defer();
        return {
          ahead: deferredAhead,
          behind: 0,
          diverged: false,
          pushed: false,
          pushError: null,
          integrateError: recovery.journal.cleanupError
            ? formatGitDiagnostic(
                `Index recovery cleanup uncertainty after durable deferred publication and owned token removal: ${recovery.journal.cleanupError}`,
              )
            : null,
          commits: [],
          skipped,
          regeneratedTrees,
          indexesDeferred: true,
          deferredIndexTrees: deferredTrees,
          deferredIndexPaths: [
            ...new Set([...deferredIndexPaths, ...warm.map((path) => path.protection.path)]),
          ].sort(),
        };
      }
    }
    const commits: SyncCommitRecord[] = recovery
      ? recovery.commits
      : integration?.mergeCommit
        ? [integration.mergeCommit]
        : [];
    for (const group of commitGroups(eligible, { itemAliases })) {
      const subject = (await closeSubject(conceptionPath, group, itemAliases)) ?? group.subject;
      if (recovery) await recoveryRecord(recovery, group.paths, subject);
      else commits.push(await record(conceptionPath, group.paths, subject, options.dryRun));
    }
    if (indexPaths.length > 0) {
      if (recovery) await recoveryRecord(recovery, indexPaths, INDEX_COMMIT_SUBJECT);
      else
        commits.push(
          await record(conceptionPath, indexPaths, INDEX_COMMIT_SUBJECT, options.dryRun),
        );
    }

    return {
      ...(recovery
        ? await finishRecoveryRun(recovery)
        : await pushState(conceptionPath, options, integration)),
      commits,
      skipped,
      regeneratedTrees,
      indexesDeferred: deferredIndexTrees.length > 0,
      deferredIndexTrees,
      deferredIndexPaths,
    };
  } catch (error) {
    if (!recovery) {
      if (!recoverySelected) throw error;
      const evidence = await inspectRecoveryEvidence(gitDir).catch(() => null);
      return integrationFailure(conceptionPath, options, {
        ahead: await upstreamAhead(conceptionPath),
        behind: await behindUpstream(conceptionPath),
        diverged: false,
        integrateError: formatGitDiagnostic(
          evidence === null || evidence.length
            ? `Index recovery stopped before normalization; manual reconciliation required. Evidence=${JSON.stringify(evidence?.map((item) => item.path) ?? gitDir)}. ${formatGitDiagnostic(error)}`
            : `Fast-forward generated-index recovery refused before normalization: ${recoveryBlockers.map((path) => JSON.stringify(path)).join(', ')}. ${formatGitDiagnostic(error)}`,
        ),
      });
    }
    const snapshot = recovery.journal.snapshot();
    const actualHead = await exec('git', ['rev-parse', 'HEAD'], { cwd: conceptionPath }).then(
      (result) => result.stdout.trim(),
      () => 'unknown',
    );
    const observedCommits = await exec(
      'git',
      ['rev-list', '--reverse', `${snapshot.initial.upstreamOid}..HEAD`],
      {
        cwd: conceptionPath,
        maxBuffer: 4096,
      },
    ).then(
      (result) => result.stdout.trim().split('\n').filter(Boolean),
      () => null,
    );
    const failure = formatGitDiagnostic(
      `Index recovery stopped; manual reconciliation required. Evidence=${JSON.stringify(recovery.journal.directory)} phase=${snapshot.phase} expectedHEAD=${snapshot.expected.head} actualHEAD=${actualHead} pending=${snapshot.intents.filter((intent) => intent.status === 'pending').length} verifiedCommits=${recovery.commits.length} observedLocalCommits=${observedCommits === null ? 'unknown' : observedCommits.join(',') || 'none'} push=${recovery.pushOutcome}. ${formatGitDiagnostic(error)}`,
    );
    await recovery.journal.recordFailure(new Error(failure)).catch(() => {});
    await recovery.journal.releaseForManualReconciliation().catch(() => {});
    return {
      ahead: await upstreamAhead(conceptionPath),
      behind: await behindUpstream(conceptionPath),
      diverged: false,
      pushed: recovery.pushOutcome === 'pushed',
      pushError: recovery.pushError,
      integrateError: failure,
      commits: recovery.commits,
      skipped: [],
      regeneratedTrees: recovery.regeneratedTrees,
      indexesDeferred: false,
      deferredIndexTrees: [],
      deferredIndexPaths: [],
    };
  }
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
      if (integration?.integrateError)
        return integrationFailure(conceptionPath, options, integration);

      const prefix = `${itemRelPath}/`;
      const paths = (await readChangedPaths(conceptionPath))
        .map(({ path }) => path)
        .filter((path) => path.startsWith(prefix))
        .sort();
      if (paths.length === 0) {
        throw new SyncRefusedError(`No changes under ${itemRelPath}`);
      }

      const commits = [
        ...(integration?.mergeCommit ? [integration.mergeCommit] : []),
        await record(conceptionPath, paths, message, options.dryRun),
      ];
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
  body: (
    gitDir: string,
    lock: SyncLock,
    transferred: () => void,
  ) => Promise<Omit<SyncReport, 'locked' | 'heldBy' | 'dryRun'>>,
  { silentWhenLocked = true }: { silentWhenLocked?: boolean } = {},
): Promise<SyncReport> {
  assertSyncRootEnvironment();
  const gitDir = await resolveGitDir(conceptionPath);
  await assertNoUnfinishedRecovery(gitDir);
  const acquired = await acquireSyncLock(gitDir).catch(async (error: unknown) => {
    // A journal can appear between discovery and exclusive creation; preserve the same entry-point refusal.
    await assertNoUnfinishedRecovery(gitDir);
    throw error;
  });
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
  let transferred = false;
  try {
    const rest = await body(gitDir, acquired.lock, () => {
      transferred = true;
    });
    return { locked: false, heldBy: null, dryRun, ...rest };
  } finally {
    if (!transferred) await acquired.lock.release();
  }
}

function assertSyncRootEnvironment(): void {
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])
    if (process.env[key] !== undefined)
      throw new SyncRefusedError(`Sync root/index redirection is unsupported: ${key}`);
}

async function assertNoUnfinishedRecovery(gitDir: string): Promise<void> {
  const evidence = await inspectRecoveryEvidence(gitDir);
  if (!evidence.length) return;
  const first = evidence[0];
  let details = `phase=${JSON.stringify(first.phase)} generation=${first.generation ?? 'unknown'}`;
  let reason = first.reason;
  try {
    const record = await readRecoveryManifest(first.path);
    details = `phase=${JSON.stringify(record.phase)} generation=${record.generation} expectedHEAD=${record.expected.head} pending=${record.intents.filter((intent) => intent.status === 'pending').length}`;
  } catch (error) {
    reason = `authoritative metadata/evidence invalid or incomplete: ${formatGitDiagnostic(error)}`;
  }
  throw new SyncRefusedError(
    formatGitDiagnostic(
      `Unresolved index recovery; manual reconciliation required. Evidence=${JSON.stringify(first.path)} ${details}. ${reason}`,
    ),
  );
}

const RECOVERY_GIT_LIMITS = {
  maxBytes: RECOVERY_LIMITS.journalBytes,
  maxEntries: RECOVERY_LIMITS.entries,
};
const RECOVERY_BLOB_LIMITS = { ...RECOVERY_GIT_LIMITS, maxBytes: RECOVERY_LIMITS.indexBytes };

function hasGeneratedOverlap(
  local: readonly ChangedPath[],
  incoming: readonly RecoveryGitChange[],
): boolean {
  const names = new Set(incoming.map((change) => change.path));
  const sorted = [...names].sort();
  return local.some(({ path }) => {
    if (!/^(projects|knowledge)\//.test(path) || basename(path) !== 'index.md') return false;
    if (names.has(path)) return true;
    const parts = path.split('/');
    let ancestor = '';
    for (const part of parts.slice(0, -1)) {
      ancestor = ancestor ? `${ancestor}/${part}` : part;
      if (names.has(ancestor)) return true;
    }
    const prefix = `${path}/`;
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (sorted[middle] < prefix) low = middle + 1;
      else high = middle;
    }
    return sorted[low]?.startsWith(prefix) ?? false;
  });
}

interface RecoveryRun {
  root: string;
  journal: RecoveryJournal;
  outputs: Set<string>;
  proof: RecoveryAttributeProof | null;
  lifecycle: IndexRecoveryLifecycle;
  commits: SyncCommitRecord[];
  committed: Map<string, Buffer>;
  regeneratedTrees: string[];
  pushOutcome: 'not-attempted' | 'pushed' | 'uncertain';
  pushError: string | null;
}

function recoveryRun(root: string, journal: RecoveryJournal): RecoveryRun {
  const context: RecoveryRun = {
    root,
    journal,
    outputs: new Set(
      journal
        .snapshot()
        .paths.filter((path) => path.protection.role === 'output')
        .map((path) => path.protection.path),
    ),
    proof: null,
    commits: [],
    committed: new Map(),
    regeneratedTrees: [],
    pushOutcome: 'not-attempted',
    pushError: null,
    lifecycle: {
      validateInput: (input) => ensureRecoveryInput(context, input),
      applyOutput: async (output) => {
        if (output.renames.length)
          throw new Error(
            `Recovery generator rename ambiguity: ${JSON.stringify(relative(root, output.path))}`,
          );
        await ensureRecoveryInput(context, { path: output.path, kind: 'output' });
        await journal.applyOutput(relative(root, output.path), output.input, output.proposed, () =>
          verifyRecoveryProof(context),
        );
      },
      applyMarker: async (marker) =>
        journal.applyMarker(relative(root, marker.path), marker.input, marker.proposed),
    },
  };
  return context;
}

function pinnedDirectories(root: string, tree: string, budget?: RecoveryBudget) {
  const cache = new Map<string, RecoveryDirectoryEntry[] | null>();
  async function directory(path: string): Promise<RecoveryDirectoryEntry[] | null> {
    const name = relative(root, path);
    if (name === '..' || name.startsWith('../') || resolve(root, name) !== path)
      throw new Error('Pinned directory escaped recovery root');
    budget?.checkPreflight();
    if (cache.has(path)) return cache.get(path)!;
    let oid = tree;
    if (name) {
      const parent = await directory(dirname(path));
      const entry = parent?.find((entry) => entry.name === basename(path));
      if (!entry) {
        cache.set(path, null);
        return null;
      }
      if (entry.kind !== 'directory')
        throw new Error(`Unsupported pinned input ancestor: ${JSON.stringify(name)}`);
      oid = entry.oid;
    }
    const entries = await readRecoveryDirectory(root, oid, RECOVERY_GIT_LIMITS);
    budget?.countEntries(entries.length);
    cache.set(path, entries);
    return entries;
  }
  const reader: IndexDirectoryReader = async (path) =>
    (await directory(path))?.map(({ name, kind }) => ({ name, kind })) ?? null;
  const entry = async (path: string) =>
    (await directory(dirname(join(root, path))))?.find((entry) => entry.name === basename(path)) ??
    null;
  return { reader, entry };
}

async function prepareRecoveryRun(
  root: string,
  gitDir: string,
  lock: SyncLock,
  options: SyncRunOptions,
  cutoffMs: number,
  local: ChangedPath[],
  incoming: { head: string; incoming: string; changes: RecoveryGitChange[] },
  hooks: RecoveryPersistenceHooks | undefined,
  attach: (context: RecoveryRun) => void,
  transferEvidence: () => void,
): Promise<RecoveryRun> {
  if (
    options.dryRun ||
    !options.push ||
    options.integration === 'off' ||
    !Number.isFinite(options.quietPeriodSeconds) ||
    options.quietPeriodSeconds < 0 ||
    !Number.isFinite(cutoffMs)
  )
    throw new Error('Unsupported recovery invocation');
  const lease = await promoteSyncLock(lock);
  let context: RecoveryRun | null = null;
  try {
    const budget = new RecoveryBudget();
    const state = await readRecoveryGitState(root, RECOVERY_GIT_LIMITS);
    if (
      state.head !== incoming.head ||
      state.upstreamOid !== incoming.incoming ||
      state.gitDir !== gitDir
    )
      throw new Error('Pinned recovery selection drift');
    await assertRecoveryFastForward(root, state, RECOVERY_GIT_LIMITS);
    if (
      state.pushRemote !== state.remote ||
      state.pushMergeRef !== state.mergeRef ||
      state.pushRef !== state.upstream ||
      JSON.stringify(state.pushUrls) !== JSON.stringify(state.remoteUrls) ||
      state.config.some(
        ({ key, value }) =>
          /^remote\..*\.push$/.test(key) ||
          (/^remote\..*\.mirror$/.test(key) && value !== 'false') ||
          (key === 'push.followtags' && value !== 'false'),
      )
    )
      throw new Error('Recovery requires one unambiguous upstream push destination');
    const outputs = new Set<string>();
    const currentOutputs = new Set<string>();
    const census = new Set<string>();
    const inputs = new Set<string>();
    const counted = new Set<string>();
    const count = (path: string) => {
      if (!counted.has(path)) {
        budget.countEntries();
        counted.add(path);
      }
    };
    const validation: IndexRecoveryLifecycle = {
      validateInput: async (input) => {
        count(relative(root, input.path) || '.');
        await validateRecoveryInput(root, input);
      },
      applyOutput: async () => {
        throw new Error('Preparation must not render/write');
      },
      applyMarker: async () => {
        throw new Error('Preparation must not change markers');
      },
    };
    const head = pinnedDirectories(root, state.head, budget);
    const target = pinnedDirectories(root, state.upstreamOid, budget);
    const virtualValidation: IndexRecoveryLifecycle = {
      ...validation,
      validateInput: async (input) => {
        count(relative(root, input.path) || '.');
      },
    };
    for (const [, strategy] of TREES) {
      const actual = await enumerateIndexPaths(root, strategy, validation);
      for (const path of actual.outputs) {
        count(path);
        currentOutputs.add(path);
        outputs.add(path);
        census.add(path);
      }
      for (const path of actual.inputs) {
        count(path);
        inputs.add(path);
        if (basename(path) === 'index.md') census.add(path);
      }
      for (const pinned of [head, target]) {
        const prospective = await enumerateIndexPaths(
          root,
          strategy,
          virtualValidation,
          pinned.reader,
        );
        for (const path of prospective.outputs) {
          count(path);
          outputs.add(path);
          census.add(path);
        }
        for (const path of prospective.inputs) {
          count(path);
          inputs.add(path);
          if (basename(path) === 'index.md') census.add(path);
        }
      }
    }
    for (const path of local)
      if (/^(projects|knowledge)\//.test(path.path) && basename(path.path) === 'index.md') {
        count(path.path);
        outputs.add(path.path);
        census.add(path.path);
      }
    const candidates = selectRecoveryCandidatePaths(local, incoming.changes, currentOutputs, state);
    if (!candidates.length) throw new Error('No qualified generated-output overlap');
    for (const delta of incoming.changes) {
      budget.checkPreflight();
      if (delta.status !== 'A') continue;
      let ancestor = root;
      for (const component of delta.path.split('/')) {
        ancestor = join(ancestor, component);
        const stat = await fs.lstat(ancestor).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (!stat) break;
        const name = relative(root, ancestor);
        if (
          state.entries.some((entry) => entry.path === name) &&
          incoming.changes.some((change) => change.path === name && change.status === 'D')
        )
          break;
        if (ancestor === join(root, delta.path) || !stat.isDirectory())
          throw new Error(
            `Incoming path collides with existing ignored/untracked topology: ${JSON.stringify(delta.path)}`,
          );
      }
    }
    for (const path of inputs) {
      await validateRecoveryInput(root, {
        path: join(root, path),
        kind: basename(path) === 'README.md' ? 'readme' : 'source',
      });
      const entry = await target.entry(path);
      if (entry && !['100644', '100755'].includes(entry.mode))
        throw new Error(`Unsupported incoming strategy input: ${JSON.stringify(path)}`);
    }
    for (const path of outputs) {
      await validateRecoveryInput(root, { path: join(root, path), kind: 'output' });
      for (const entry of [
        state.entries.find((entry) => entry.path === path),
        await head.entry(path),
        await target.entry(path),
      ])
        if (entry && entry.mode !== '100644')
          throw new Error(`Unsupported protected output Git mode: ${JSON.stringify(path)}`);
    }
    const blob = async (entry: { oid: string } | null | undefined) => {
      if (!entry) return null;
      let reservation = 0;
      try {
        return await readRecoveryBlob(root, entry.oid, RECOVERY_BLOB_LIMITS, (size) => {
          budget.reserve(size);
          reservation = size;
        });
      } finally {
        if (reservation) budget.releaseReservation(reservation);
      }
    };
    for (const path of candidates) {
      const actual = await observeRecoveryFile(root, path, true);
      const saved = await blob(state.entries.find((entry) => entry.path === path));
      if (!actual.bytes || !saved || !recoveryCandidateQualifies(actual.bytes, saved))
        throw new Error(`Protected raw candidate edits cannot normalize: ${JSON.stringify(path)}`);
    }
    await assertRecoveryGitState(root, state, RECOVERY_GIT_LIMITS);
    await lease.assertOwned();
    await lock.assertOwned();
    // Create-time support checks must fail while the ordinary lock is still
    // ours to release: after `transferEvidence()` the lock's cleanup belongs
    // to the journal, so a pre-evidence failure would leave a live sweeper
    // blocked up to the stale window.
    assertRecoveryJournalPreconditions({ root, gitDir, state, lock, lease });
    // Same discipline for the four read-only create-time checks (round 2):
    // capture their results pre-transfer and hand them to `create`, whose
    // post-transfer region must stay exactly its tested publication sequence.
    const bootstrap = await prepareRecoveryJournalBootstrap({ root, gitDir, state, hooks });
    transferEvidence();
    const journal = await RecoveryJournal.create({
      root,
      gitDir,
      state,
      lock,
      lease,
      budget,
      bootstrap,
      invocation: {
        kind: 'syncRun',
        dryRun: false,
        push: true,
        integration: options.integration,
        quietPeriodSeconds: options.quietPeriodSeconds,
        cutoffMs,
      },
      hooks,
    });
    context = recoveryRun(root, journal);
    attach(context);
    context.outputs = outputs;
    for (const path of census) {
      budget.checkPreflight();
      const before = await head.entry(path);
      const after = await target.entry(path);
      if (
        (before && !['100644', '100755'].includes(before.mode)) ||
        (after && !['100644', '100755'].includes(after.mode))
      )
        throw new Error(`Unsupported protected source Git type: ${JSON.stringify(path)}`);
      const delta = incoming.changes.find((change) => change.path === path);
      const kind = delta
        ? delta.status === 'M'
          ? 'modified'
          : delta.status === 'A'
            ? 'added'
            : delta.status === 'D'
              ? 'deleted'
              : null
        : 'unchanged';
      if (!kind)
        throw new Error(`Unsupported protected input type transition: ${JSON.stringify(path)}`);
      const actual = await observeRecoveryFile(root, path, outputs.has(path));
      await journal.addPath({
        path,
        role: outputs.has(path) ? 'output' : 'source',
        incoming: kind,
        head: await blob(before),
        incomingBytes: await blob(after),
        candidate: candidates.includes(path),
        eligibleAtMs: actual.observation.identity
          ? Number(BigInt(actual.observation.identity.mtimeNs)) / 1e6
          : 0,
      });
    }
    await refreshRecoveryProof(context);
    await journal.prepare();
    return context;
  } catch (error) {
    if (!context) await lease.close();
    throw error;
  }
}

async function refreshRecoveryProof(context: RecoveryRun): Promise<void> {
  const record = context.journal.snapshot();
  const available =
    RECOVERY_LIMITS.journalBytes -
    RECOVERY_LIMITS.emergencyBytes -
    record.resources.usedBytes -
    record.resources.reservedBytes;
  if (available <= 0) throw new Error('No recovery attribute publication allowance');
  context.proof = await context.journal.captureAttributeProof(
    Math.min(available, 64 * 1024 * 1024),
    (directory) =>
      proveInertRecoveryOutputs(
        context.root,
        record.initial.head,
        record.initial.upstreamOid,
        [...context.outputs].sort(),
        directory,
        RECOVERY_GIT_LIMITS,
      ),
  );
}

async function verifyRecoveryProof(context: RecoveryRun): Promise<void> {
  if (!context.proof) await refreshRecoveryProof(context);
  await assertRecoveryAttributeProof(context.root, context.proof!, RECOVERY_GIT_LIMITS);
}

async function recoveryFastForward(context: RecoveryRun): Promise<void> {
  const { journal, root } = context;
  const initial = journal.snapshot().initial;
  const opaqueBefore = await executablePostMergeHook(root);
  for (const path of journal.snapshot().paths.filter((path) => path.candidate))
    await journal.normalizeCandidate(path.protection.path, async () => {
      await assertRecoveryGitState(root, initial, RECOVERY_GIT_LIMITS);
      await verifyRecoveryProof(context);
    });
  await verifyRecoveryProof(context);
  const merge = await journal.beginEffect('merge', { target: initial.upstreamOid });
  const result = await ffOnlyMerge(root, initial.upstreamOid);
  if (!result.ok) throw new Error(`Pinned fast-forward failed: ${result.error}`);
  const current = await readRecoveryGitState(root, RECOVERY_GIT_LIMITS);
  const delta = await readRecoveryChanges(
    root,
    initial.head,
    initial.upstreamOid,
    RECOVERY_GIT_LIMITS,
  );
  const expectedEntries = new Map(initial.entries.map((entry) => [entry.path, entry]));
  for (const change of delta) {
    if (change.status === 'D') expectedEntries.delete(change.path);
    else
      expectedEntries.set(change.path, {
        path: change.path,
        mode: change.newMode,
        oid: change.newOid,
        stage: 0,
        flag: 'H',
        flags: '0',
      });
  }
  assertStableRecoveryIdentity(initial, current);
  if (
    current.head !== initial.upstreamOid ||
    current.upstreamOid !== initial.upstreamOid ||
    current.staged !== '' ||
    current.entries.length !== expectedEntries.size ||
    current.entries.some(
      (entry) => JSON.stringify(entry) !== JSON.stringify(expectedEntries.get(entry.path)),
    )
  )
    throw new Error('Pinned checkout HEAD/index/operation identity differs from M');
  await journal.completeEffect(merge, current);
  await journal.adoptActual({
    observedAtMs: Date.now(),
    opaqueHook: opaqueBefore || (await executablePostMergeHook(root)),
  });
  context.proof = null;
  await refreshRecoveryPaths(context);
}

async function executablePostMergeHook(root: string): Promise<boolean> {
  const { stdout } = await exec('git', ['rev-parse', '--git-path', 'hooks/post-merge'], {
    cwd: root,
  });
  const stat = await fs.stat(resolve(root, stdout.trim())).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  return !!stat?.isFile() && (stat.mode & 0o111) !== 0;
}

async function ensureRecoveryInput(context: RecoveryRun, input: IndexRecoveryInput): Promise<void> {
  const path = relative(context.root, input.path);
  if (
    basename(path) === 'index.md' &&
    /^(projects|knowledge)\//.test(path) &&
    input.kind !== 'directory'
  ) {
    const output = input.kind === 'output';
    if (output && !context.outputs.has(path)) {
      context.outputs.add(path);
      await refreshRecoveryProof(context);
    }
    const retained = context.journal
      .snapshot()
      .paths.find((entry) => entry.protection.path === path);
    if (!retained) {
      const record = context.journal.snapshot();
      const head = await pinnedDirectories(context.root, record.initial.head).entry(path);
      const incoming = await pinnedDirectories(context.root, record.initial.upstreamOid).entry(
        path,
      );
      const changes = await readRecoveryChanges(
        context.root,
        record.initial.head,
        record.initial.upstreamOid,
        RECOVERY_GIT_LIMITS,
      );
      const delta = changes.find((entry) => entry.path === path);
      const kind = delta
        ? delta.status === 'M'
          ? 'modified'
          : delta.status === 'A'
            ? 'added'
            : delta.status === 'D'
              ? 'deleted'
              : null
        : 'unchanged';
      if (!kind || (head && head.kind !== 'file') || (incoming && incoming.kind !== 'file'))
        throw new Error('Unsupported dynamically discovered index');
      await context.journal.addPath({
        path,
        role: output ? 'output' : 'source',
        incoming: kind,
        head: head ? await context.journal.readBlob(head.oid) : null,
        incomingBytes: incoming ? await context.journal.readBlob(incoming.oid) : null,
        eligibleAtMs: Date.now(),
      });
    } else if (output && retained.protection.role !== 'output')
      await context.journal.promoteOutput(path, () => verifyRecoveryProof(context));
  }
  await context.journal.validateInput(input);
}

async function refreshRecoveryPaths(context: RecoveryRun): Promise<void> {
  for (const [, strategy] of TREES) {
    const paths = await enumerateIndexPaths(context.root, strategy, context.lifecycle);
    for (const path of paths.outputs)
      await ensureRecoveryInput(context, { path: join(context.root, path), kind: 'output' });
  }
  if (!context.proof) await refreshRecoveryProof(context);
}

async function recoveryCheckpoint(context: RecoveryRun): Promise<void> {
  await context.journal.checkpoint(async () => {
    await verifyRecoveryProof(context);
    const state = context.journal.snapshot().expected;
    if (context.committed.size)
      await verifyRecoveryOutputObjects(
        context.root,
        { commit: state.head },
        [...context.committed].map(([path, bytes]) => ({ path, bytes })),
        RECOVERY_BLOB_LIMITS,
      );
  });
}

function assertStableRecoveryIdentity(before: RecoveryGitState, after: RecoveryGitState): void {
  const identity = (state: RecoveryGitState) => {
    const {
      head: _head,
      upstreamOid: _upstream,
      entries: _entries,
      staged: _staged,
      ...identity
    } = state;
    return identity;
  };
  if (JSON.stringify(identity(before)) !== JSON.stringify(identity(after)))
    throw new Error('Recovery full attached/upstream/config identity drift');
}

async function recoveryRecord(
  context: RecoveryRun,
  paths: string[],
  subject: string,
): Promise<void> {
  const { root, journal } = context;
  const outputs: { path: string; bytes: Buffer }[] = [];
  for (const path of paths)
    if (/^(projects|knowledge)\//.test(path) && basename(path) === 'index.md') {
      await ensureRecoveryInput(context, { path: join(root, path), kind: 'output' });
      const actual = await observeRecoveryFile(root, path, true);
      if (!actual.bytes) throw new Error('Selected protected output is absent');
      assertRecoveryRequirements(
        actual.bytes,
        journal.snapshot().paths.find((entry) => entry.protection.path === path)!.protection
          .requirements,
      );
      outputs.push({ path, bytes: actual.bytes });
    }
  const verifyCurrent = async () => {
    await recoveryCheckpoint(context);
    const record = journal.snapshot();
    if (
      record.paths.some(
        (path) =>
          path.protection.role === 'output' &&
          path.original.identity &&
          path.eligibleAtMs > record.invocation.cutoffMs,
      )
    )
      throw new Error('Recovery output became quiet-ineligible after commit selection');
    for (const output of outputs) {
      const actual = await observeRecoveryFile(root, output.path, true);
      if (!actual.bytes?.equals(output.bytes)) throw new Error('Selected recovery output drift');
    }
  };
  let intent = '';
  let before = journal.snapshot().expected;
  await commitPaths(root, paths, subject, {
    beforeAdd: async (chunk) => {
      await verifyCurrent();
      before = journal.snapshot().expected;
      intent = await journal.beginEffect('stage', { paths: [...chunk] });
      await verifyCurrent();
    },
    afterAdd: async (chunk) => {
      const current = await readRecoveryGitState(root, RECOVERY_GIT_LIMITS, { allowStaged: true });
      assertStableRecoveryIdentity(before, current);
      const allowed = new Set(chunk);
      const unchanged = new Map(
        before.entries
          .filter((entry) => !allowed.has(entry.path))
          .map((entry) => [entry.path, entry]),
      );
      if (
        current.head !== before.head ||
        current.upstreamOid !== before.upstreamOid ||
        current.entries.filter((entry) => !allowed.has(entry.path)).length !== unchanged.size ||
        current.entries.some(
          (entry) =>
            !allowed.has(entry.path) &&
            JSON.stringify(entry) !== JSON.stringify(unchanged.get(entry.path)),
        )
      )
        throw new Error('Foreign stage/ref mutation during recovery add');
      await verifyRecoveryOutputObjects(
        root,
        { stage: current.entries },
        outputs.filter((output) => allowed.has(output.path)),
        RECOVERY_BLOB_LIMITS,
      );
      await journal.completeEffect(intent, current);
    },
    beforeCommit: async () => {
      await verifyCurrent();
      before = journal.snapshot().expected;
      await verifyRecoveryOutputObjects(
        root,
        { stage: before.entries },
        outputs,
        RECOVERY_BLOB_LIMITS,
      );
      intent = await journal.beginEffect('commit', { paths: [...paths], subject });
      await verifyCurrent();
    },
    afterCommit: async (_paths, sha) => {
      if (!sha) throw new Error('Recovery commit did not return an observed object');
      context.commits.push({ sha, paths: [...paths], subject });
      const current = await readRecoveryGitState(root, RECOVERY_GIT_LIMITS);
      assertStableRecoveryIdentity(before, current);
      const { stdout: parents } = await exec('git', ['rev-list', '--parents', '-n', '1', sha], {
        cwd: root,
      });
      if (
        current.head !== sha ||
        parents.trim() !== `${sha} ${before.head}` ||
        current.upstreamOid !== before.upstreamOid ||
        JSON.stringify(current.entries) !== JSON.stringify(before.entries) ||
        current.staged !== ''
      )
        throw new Error('Unexpected recovery commit/ref/index transition');
      await verifyRecoveryCommitTree(root, sha, before.entries, RECOVERY_GIT_LIMITS);
      await verifyRecoveryOutputObjects(
        root,
        { commit: sha },
        [...context.committed].map(([path, bytes]) => ({ path, bytes })).concat(outputs),
        RECOVERY_BLOB_LIMITS,
      );
      await verifyRecoveryProof(context);
      await journal.completeEffect(intent, current);
      for (const output of outputs) context.committed.set(output.path, output.bytes);
    },
  });
}

async function finishRecoveryRun(
  context: RecoveryRun,
): Promise<
  Pick<SyncReport, 'ahead' | 'behind' | 'diverged' | 'pushed' | 'pushError' | 'integrateError'>
> {
  await recoveryCheckpoint(context);
  const ahead = await upstreamAhead(context.root);
  if (ahead !== null && ahead > 0) {
    const before = context.journal.snapshot().expected;
    const intent = await context.journal.beginEffect('push', {
      remote: before.pushRemote,
      destination: before.pushMergeRef,
    });
    context.pushOutcome = 'uncertain';
    try {
      await push(context.root);
    } catch (error) {
      context.pushError = formatGitDiagnostic(error);
      throw error;
    }
    const current = await readRecoveryGitState(context.root, RECOVERY_GIT_LIMITS);
    assertStableRecoveryIdentity(before, current);
    if (
      current.head !== before.head ||
      current.staged !== before.staged ||
      JSON.stringify(current.entries) !== JSON.stringify(before.entries) ||
      ![before.upstreamOid, before.head].includes(current.upstreamOid)
    )
      throw new Error('Unexpected recovery push transition');
    await context.journal.completeEffect(intent, current);
    context.pushOutcome = 'pushed';
  }
  const state = context.journal.snapshot().expected;
  const finalAhead = await upstreamAhead(context.root);
  await context.journal.finish(
    {
      head: state.head,
      commits: context.commits.map((commit) => commit.sha!),
      staged: state.staged,
      push: context.pushOutcome,
      protectedVerified: true,
    },
    async () => {
      await verifyRecoveryProof(context);
      await verifyRecoveryOutputObjects(
        context.root,
        { commit: state.head },
        [...context.committed].map(([path, bytes]) => ({ path, bytes })),
        RECOVERY_BLOB_LIMITS,
      );
    },
  );
  return {
    ahead: finalAhead,
    behind: 0,
    diverged: false,
    pushed: context.pushOutcome === 'pushed',
    pushError: null,
    integrateError: context.journal.cleanupError
      ? formatGitDiagnostic(
          `Index recovery cleanup uncertainty after durable terminal publication and owned token removal: ${context.journal.cleanupError}`,
        )
      : null,
  };
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
  recovery?: IndexRecoveryLifecycle,
): Promise<SyncTree[]> {
  const regenerated: SyncTree[] = [];
  for (const [tree, strategy] of TREES) {
    if (gates.heldBackTrees.has(tree)) continue;
    const due =
      gates.forceTrees.has(tree) || (await exists(join(conceptionPath, tree, '.index-dirty')));
    if (!due) continue;
    await regenerateIndex(conceptionPath, strategy, { dryRun, recovery });
    regenerated.push(tree);
  }
  return regenerated;
}

/**
 * Milestone subject for an item group whose sweep introduces the README's
 * `Closed.` timeline entry, or `null` to keep the group's `<item>: sync`
 * default. Closing is write-files-only for agents, so the real history line
 * has to come from the sweeper itself.
 *
 * `itemAliases` (old item → renamed item) keeps a renamed already-closed item
 * from masquerading as a fresh close: the README's HEAD history lives under
 * the OLD path, so when the new path has no blob in HEAD, the old README's
 * HEAD text is compared instead.
 */
async function closeSubject(
  conceptionPath: string,
  group: CommitGroup,
  itemAliases: ReadonlyMap<string, string>,
): Promise<string | null> {
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
  let headText = await readFileAtHead(conceptionPath, readmeRel);
  if (headText === null) {
    const oldReadmeRel = group.paths.find((path) => {
      const segments = path.split('/');
      return (
        segments.length === 4 &&
        segments[0] === 'projects' &&
        itemAliases.get(segments[2]) === group.key &&
        segments[3] === 'README.md'
      );
    });
    if (oldReadmeRel) headText = await readFileAtHead(conceptionPath, oldReadmeRel);
  }
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
type Integration = Pick<SyncReport, 'ahead' | 'behind' | 'diverged' | 'integrateError'> & {
  mergeCommit?: SyncCommitRecord;
};

/**
 * Fetch the remote and fast-forward it when it is ahead-only, so the sweep's
 * own commits keep the push a fast-forward. Only opt-in safe-merge may join
 * diverged committed snapshots, without rebasing or touching dirty user work.
 * Unsafe recovery retains the divergence and refuses the push.
 *
 * Returns `null` when the run won't push (dry-run, `--no-push`, or
 * `autoSync.integration: 'off'`), leaving `pushState` on the legacy
 * reporting path.
 */
async function integrateBeforePush(
  conceptionPath: string,
  options: SyncOptions,
  guardedFastForward?: () => Promise<boolean>,
): Promise<Integration | null> {
  if (options.dryRun || !options.push || options.integration === 'off') return null;

  try {
    await fetchUpstream(conceptionPath);
  } catch (err) {
    return {
      ahead: null,
      behind: null,
      diverged: false,
      integrateError: formatGitDiagnostic(`fetch failed: ${formatGitDiagnostic(err)}`),
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
  let mergeCommit: SyncCommitRecord | undefined;
  if (behind > 0 && ahead === 0) {
    if (guardedFastForward && (await guardedFastForward()))
      return { ahead, behind: 0, diverged: false, integrateError: null };
    const ff = await ffOnlyMerge(conceptionPath);
    if (!ff.ok) {
      integrateError = formatGitDiagnostic(`fast-forward failed: ${ff.error}`);
    } else {
      // The remote commits are now on HEAD; the sweep's own commits will keep
      // the push a fast-forward.
      resolvedBehind = 0;
    }
  } else if (behind > 0 && ahead > 0) {
    diverged = true;
    if (options.integration === 'safe-merge') {
      try {
        mergeCommit = await safeMerge(conceptionPath);
        resolvedBehind = 0;
        diverged = false;
      } catch (error) {
        integrateError = formatGitDiagnostic(`safe merge refused: ${formatGitDiagnostic(error)}`);
      }
    }
  }

  return { ahead, behind: resolvedBehind, diverged, integrateError, mergeCommit };
}

/**
 * Push when asked and when there's something to push. A rejected push is
 * recorded, not repaired: `git pull --rebase` would rewrite the tree under a
 * live session, which is the very race sync exists to prevent.
 *
 * With an integration result, a divergence or a failed integration refuses the
 * push outright; an integration error has already gated new commits.
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

  // Explicit ff-only divergence retains its local-commit behavior; errors
  // reached this point without creating new commits.
  if (integration.diverged || integration.integrateError) {
    return {
      ahead: await upstreamAhead(conceptionPath),
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

async function integrationFailure(
  conceptionPath: string,
  options: SyncOptions,
  integration: Integration,
) {
  return {
    ...(await pushState(conceptionPath, options, integration)),
    commits: [],
    skipped: [],
    regeneratedTrees: [],
    indexesDeferred: false,
    deferredIndexTrees: [],
    deferredIndexPaths: [],
  };
}

async function captureIndexMtimes(
  conceptionPath: string,
  changed: ChangedPath[],
  mtimes: Map<string, number>,
): Promise<void> {
  for (const { path } of changed) {
    if (classifyPath(path).kind !== 'index') continue;
    const stat = await fs.stat(join(conceptionPath, path)).catch(() => null);
    mtimes.set(path, stat?.mtimeMs ?? 0);
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

/** Every path settled — a rename pair moves as one unit, so the NEW side's
 *  mtimes decide (the old side is deleted on disk and settled by definition). */
async function pathsSettled(
  conceptionPath: string,
  paths: readonly string[],
  cutoffMs: number,
): Promise<boolean> {
  for (const path of paths) {
    if (!(await isSettled(join(conceptionPath, path), cutoffMs))) return false;
  }
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
