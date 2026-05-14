import { transitionStatus } from '../../main/mutate';
import { checkBranchState } from '../../main/worktree-ops';
import { touchDirtyMarker } from '../../main/dirty';
import { KNOWN_STATUSES } from '../../shared/types';
import { resolveSlug } from '../slug-resolver';
import { CliError, ExitCodes, emit, validation, type OutputContext } from '../output';
import { readHeader } from '../../main/header-io';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';

export async function statusCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const sub = args.positional[0];
  if (sub === 'get') {
    const slug = args.positional[1];
    if (!slug) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects status get <slug>');
    assertNoExtraFlags(args);
    const candidate = await resolveSlug(conceptionPath, slug);
    const header = await readHeader(candidate.readmePath);
    emit(
      ctx,
      { slug: candidate.slug, status: header.status },
      (d) => `${(d as { status: string | null }).status ?? '(missing)'}\n`,
    );
    return;
  }
  if (sub === 'set') {
    const slug = args.positional[1];
    const value = args.positional[2];
    if (!slug || !value) {
      throw new CliError(ExitCodes.USAGE, 'Usage: condash projects status set <slug> <status>');
    }
    if (!(KNOWN_STATUSES as readonly string[]).includes(value)) {
      validation(`Status '${value}' not in {${KNOWN_STATUSES.join(', ')}}`);
    }
    const summary = typeof args.flags.summary === 'string' ? args.flags.summary.trim() : undefined;
    delete args.flags.summary;
    assertNoExtraFlags(args);
    const candidate = await resolveSlug(conceptionPath, slug);
    const transition = await transitionStatus(candidate.readmePath, value, { summary });
    const dirtyMarker = await touchDirtyMarker(conceptionPath, 'projects');
    emit(
      ctx,
      {
        slug: candidate.slug,
        path: candidate.readmePath,
        previousStatus: transition.previousStatus,
        newStatus: transition.newStatus,
        timelineAppended: transition.timelineAppended,
        dirtyMarkerTouched: dirtyMarker,
      },
      (d) => {
        const data = d as { previousStatus: string | null; newStatus: string };
        return `${data.previousStatus ?? '(none)'} → ${data.newStatus}\n`;
      },
    );
    return;
  }
  throw new CliError(ExitCodes.USAGE, 'Usage: condash projects status <get|set> <slug> [<value>]');
}

export async function closeProject(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const slug = args.positional[0];
  if (!slug) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects close <slug>');
  const newStatus = (args.flags.status as string | undefined) ?? 'done';
  if (!(KNOWN_STATUSES as readonly string[]).includes(newStatus)) {
    validation(`Status '${newStatus}' not in {${KNOWN_STATUSES.join(', ')}}`);
  }
  const summary = (args.flags.summary as string | undefined)?.trim();
  const noTouchDirty = args.flags['no-touch-dirty'] === true;
  for (const k of ['status', 'summary', 'no-touch-dirty']) delete args.flags[k];
  assertNoExtraFlags(args);

  const candidate = await resolveSlug(conceptionPath, slug);
  const header = await readHeader(candidate.readmePath);
  const transition = await transitionStatus(candidate.readmePath, newStatus, { summary });

  const dirtyMarker = noTouchDirty ? false : await touchDirtyMarker(conceptionPath, 'projects');

  const warnings = await leftoverBranchWarnings(conceptionPath, header.branch);

  emit(
    ctx,
    {
      slug: candidate.slug,
      path: candidate.readmePath,
      previousStatus: transition.previousStatus,
      newStatus: transition.newStatus,
      timelineAppended: transition.timelineAppended,
      dirtyMarkerTouched: dirtyMarker,
    },
    (d) => {
      const data = d as { slug: string; previousStatus: string | null; newStatus: string };
      return `Closed ${data.slug}: ${data.previousStatus ?? '(none)'} → ${data.newStatus}\n`;
    },
    warnings,
  );
}

export async function reopenProject(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const slug = args.positional[0];
  if (!slug) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects reopen <slug>');
  const target = (args.flags.status as string | undefined) ?? 'now';
  if (!(KNOWN_STATUSES as readonly string[]).includes(target)) {
    validation(`Status '${target}' not in {${KNOWN_STATUSES.join(', ')}}`);
  }
  if (target === 'done') {
    validation(`reopen target cannot be 'done' — use \`condash projects close\` instead`);
  }
  delete args.flags.status;
  assertNoExtraFlags(args);
  const candidate = await resolveSlug(conceptionPath, slug);
  const header = await readHeader(candidate.readmePath);
  const previous = (header.status ?? '').toLowerCase();
  if (previous !== 'done') {
    throw new CliError(
      ExitCodes.VALIDATION,
      `Cannot reopen ${candidate.slug}: previous status is '${previous || '(none)'}', expected 'done'`,
    );
  }
  const transition = await transitionStatus(candidate.readmePath, target);
  const dirtyMarker = await touchDirtyMarker(conceptionPath, 'projects');
  emit(
    ctx,
    {
      slug: candidate.slug,
      path: candidate.readmePath,
      previousStatus: transition.previousStatus,
      newStatus: transition.newStatus,
      timelineAppended: transition.timelineAppended,
      dirtyMarkerTouched: dirtyMarker,
    },
    (d) => {
      const data = d as { slug: string; previousStatus: string | null; newStatus: string };
      return `Reopened ${data.slug}: ${data.previousStatus ?? '(none)'} → ${data.newStatus}\n`;
    },
  );
}

/**
 * Probe the closed item's branch (when the header carries one) and surface
 * a warning if the on-disk worktree or the local branch still exists. Closing
 * an item only flips Status — the actual cleanup verbs are
 * `condash worktrees remove <branch>` and `git branch -d <branch>`, and a
 * silent close lets the miss go unnoticed (this exact thing happened during
 * the parent simplify batch, May 1).
 */
async function leftoverBranchWarnings(
  conceptionPath: string,
  branch: string | null,
): Promise<string[]> {
  if (!branch) return [];
  let state;
  try {
    state = await checkBranchState(conceptionPath, branch);
  } catch {
    // checkBranchState reads condash.json + queries each repo; if the
    // probe itself fails we'd rather close cleanly than crash the verb.
    return [];
  }
  const lingeringWorktrees = state.repos.filter((r) => r.worktreeExists);
  const lingeringBranches = state.repos.filter((r) => r.localBranchExists);
  if (lingeringWorktrees.length === 0 && lingeringBranches.length === 0) return [];

  const parts: string[] = [];
  if (lingeringWorktrees.length > 0) {
    const paths = lingeringWorktrees.map((r) => r.expectedWorktree).join(', ');
    parts.push(`worktree(s) still on disk at ${paths}`);
  }
  if (lingeringBranches.length > 0) {
    const repos = lingeringBranches.map((r) => r.name).join(', ');
    parts.push(`local branch '${branch}' still exists in ${repos}`);
  }
  return [
    `${parts.join('; ')} — run \`condash worktrees remove ${branch}\` ` +
      `then \`git branch -d ${branch}\` to clean up.`,
  ];
}
