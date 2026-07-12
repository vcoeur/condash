/** `sync` noun — the conception's single writer to git.
 *
 *  Parallel agent sessions in one checkout corrupt each other three ways: the
 *  process-wide `.git/index`, the fan-in `index.md` files no session owns, and
 *  racing pushes. A conception has one author and no CI, so making exactly one
 *  process the committer dissolves all three.
 *
 *    run     the sweeper (default verb) — commit settled changes, one commit
 *            per item (with a synthesized `Close <item>. …` subject when the
 *            sweep introduces the item's close), regenerate stale indexes, push
 *    commit  a manual milestone commit for one item, under the same lock —
 *            a human escape hatch; agents never run sync verbs
 *
 *  There is no scheduler here. `run` is meant to be driven by a `systemd --user`
 *  timer, a launchd agent, or cron — condash stays a CLI with no daemon. */
import { relative } from 'node:path';
import { syncCommit, syncRun, SyncRefusedError, type SyncReport } from '../../main/sync/run';
import { toPosix } from '../../shared/path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import {
  assertNoExtraFlags,
  takeBoolFlag,
  takeIntFlag,
  takeStringFlag,
  type ParsedArgs,
} from '../parser';
import { renderHelp, runNoun } from '../help';
import { resolveSlug } from '../slug-resolver';

/** Long enough that a session mid-write is never swept, short enough that a
 *  finished edit lands within a tick or two. */
const DEFAULT_QUIET_PERIOD_SECONDS = 90;

const RUN_FLAGS = ['dry-run', 'no-push', 'quiet-period'] as const;
const COMMIT_FLAGS = ['message', 'dry-run', 'no-push'] as const;
const NOUN_FLAGS: readonly string[] = [...new Set([...RUN_FLAGS, ...COMMIT_FLAGS])];

export async function runSync(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
  universalHelp = false,
): Promise<void> {
  // Bare `condash sync` runs the sweeper. The default applies only on the
  // dispatch path — `condash sync --help` still prints the noun overview.
  const effectiveVerb = verb === null && !universalHelp ? 'run' : verb;
  await runNoun(
    'sync',
    effectiveVerb,
    args,
    {
      run: () => runRun(args, ctx, conceptionPath),
      commit: () => runCommit(args, ctx, conceptionPath),
    },
    printHelp,
    universalHelp,
  );
}

async function runRun(args: ParsedArgs, ctx: OutputContext, conceptionPath: string): Promise<void> {
  const dryRun = takeBoolFlag(args, 'dry-run');
  const noPush = takeBoolFlag(args, 'no-push');
  const quietPeriod = takeIntFlag(args, 'quiet-period', true);
  assertNoExtraFlags(args, NOUN_FLAGS);

  const report = await refuseAsCliError(() =>
    syncRun(conceptionPath, {
      dryRun,
      push: !noPush,
      quietPeriodSeconds: quietPeriod ?? DEFAULT_QUIET_PERIOD_SECONDS,
    }),
  );
  emitReport(ctx, report);
}

async function runCommit(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const message = takeStringFlag(args, 'message');
  const dryRun = takeBoolFlag(args, 'dry-run');
  const noPush = takeBoolFlag(args, 'no-push');
  assertNoExtraFlags(args, NOUN_FLAGS);

  const slug = args.positional[0];
  if (!slug) {
    throw new CliError(ExitCodes.USAGE, 'Usage: condash sync commit <item> --message "…"');
  }
  if (!message || message.trim() === '') {
    throw new CliError(ExitCodes.USAGE, '--message is required (there is no -m short flag)');
  }

  const candidate = await resolveSlug(conceptionPath, slug);
  const itemRelPath = toPosix(relative(conceptionPath, candidate.itemDir));

  const report = await refuseAsCliError(() =>
    syncCommit(conceptionPath, itemRelPath, message.trim(), { dryRun, push: !noPush }),
  );
  emitReport(ctx, report);
}

/** A refusal (mid-merge, conflicted, lock held on `commit`) is a validation
 *  failure, not a crash — exit 3 with the reason. */
async function refuseAsCliError(body: () => Promise<SyncReport>): Promise<SyncReport> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof SyncRefusedError) {
      throw new CliError(ExitCodes.VALIDATION, err.message);
    }
    throw err;
  }
}

/**
 * A rejected push is a warning, never a failure: the commits are safely local
 * and the next tick retries, because the push condition is "ahead of upstream"
 * rather than "we just committed". A sweeper on a timer must not go red over a
 * transient network blip.
 */
function emitReport(ctx: OutputContext, report: SyncReport): void {
  const warnings: string[] = [];
  if (report.locked) {
    const who = report.heldBy ? ` (pid ${report.heldBy.pid})` : '';
    warnings.push(`another condash sync holds the lock${who} — skipping this tick`);
  }
  if (report.pushError) {
    warnings.push(`push rejected, commits stay local: ${report.pushError}`);
  }
  emit(ctx, report, formatReport, warnings);
}

function formatReport(report: SyncReport): string {
  if (report.locked) return '';

  const lines: string[] = [];
  const prefix = report.dryRun ? 'would commit' : 'committed';

  for (const commit of report.commits) {
    const sha = commit.sha ? `${commit.sha.slice(0, 8)}  ` : '';
    const count = commit.paths.length;
    lines.push(`${sha}${prefix} ${commit.subject}  (${count} ${count === 1 ? 'path' : 'paths'})`);
  }
  if (report.regeneratedTrees.length > 0) {
    const verb = report.dryRun ? 'would regenerate' : 'regenerated';
    lines.push(`${verb} indexes: ${report.regeneratedTrees.join(', ')}`);
  }
  if (report.indexesDeferred) {
    lines.push('deferred index regeneration until the tree settles');
  }
  for (const skip of report.skipped) {
    lines.push(`skipped ${skip.path}  (${skip.reason})`);
  }
  if (report.pushed) {
    lines.push('pushed');
  } else if (report.ahead !== null && report.ahead > 0 && !report.dryRun && !report.pushError) {
    lines.push(`${report.ahead} commit(s) ahead of upstream, not pushed`);
  }

  if (lines.length === 0) return 'nothing to sync\n';
  return lines.join('\n') + '\n';
}

function printHelp(verb: string | null): void {
  switch (verb) {
    case 'run':
      process.stdout.write(
        renderHelp([
          'condash sync run [--dry-run] [--no-push] [--quiet-period <seconds>]',
          '',
          'Sweep the conception under an exclusive lock: commit every settled change',
          'one commit per item, regenerate stale indexes into a commit of their own,',
          'then push. Safe to run on a timer while sessions are live.',
          '',
          'A path modified within the quiet period (default 90s) is left for the next',
          'tick, so a session mid-write is never swept. If the lock is already held,',
          'this exits 0 without doing anything.',
          '',
          'When any path is held back that way, index regeneration is deferred too —',
          'an index is fan-in over every item, so committing one while an item is',
          'still mid-write would record a bullet pointing at an uncommitted directory.',
          '',
          "A sweep that introduces an item's `Closed.` timeline entry commits that",
          'item under a synthesized `Close <item>. Outcome: …` subject instead of',
          '`<item>: sync`, so closing an item stays write-files-only.',
          '',
          'Flags:',
          '  --dry-run              Report what would be committed; write nothing.',
          '  --no-push              Commit but leave the branch ahead of upstream.',
          '  --quiet-period <secs>  Skip paths modified more recently (default 90; 0 disables).',
          '',
          'Examples:',
          '  condash sync',
          '  condash sync run --dry-run',
          '  condash sync run --quiet-period 300 --no-push',
        ]),
      );
      return;
    case 'commit':
      process.stdout.write(
        renderHelp([
          'condash sync commit <item> --message "<subject>" [--dry-run] [--no-push]',
          '',
          "Commit one item's changes under a real subject line, taking the same lock as",
          '`run` so a milestone cannot race the sweeper. No quiet period applies.',
          '',
          'Unlike `run`, a held lock is an error here (exit 3) rather than a silent skip.',
          'There is no `-m` short flag — short flags are boolean-only.',
          '',
          'This is a manual escape hatch for humans. Agents never run sync verbs —',
          'the sweeper synthesizes the `Close <item>. Outcome: …` milestone subject',
          'itself when a sweep introduces the closing timeline entry.',
          '',
          'Flags:',
          '  --message <subject>  Commit subject (required).',
          '  --dry-run            Report what would be committed; write nothing.',
          '  --no-push            Commit but leave the branch ahead of upstream.',
          '',
          'Examples:',
          '  condash sync commit 2026-07-10-foo --message "Close foo: shipped v1.2.0"',
          '  condash sync commit foo --message "Open foo" --no-push',
        ]),
      );
      return;
    default:
      printSubHelp();
  }
}

function printSubHelp(): void {
  process.stdout.write(
    renderHelp([
      'condash sync <verb> [args]',
      '',
      'Single-writer commit surface for a conception shared by parallel sessions.',
      '',
      'Verbs:',
      '  run     Sweep and commit settled changes, one commit per item (default).',
      '  commit  Manual milestone commit for one item, under the same lock.',
    ]),
  );
}
