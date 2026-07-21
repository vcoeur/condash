import { promises as fs } from 'node:fs';
import { appendTimelineEntry, parseTimelineEntries, transitionStatus } from '../../main/mutate';
import { checkBranchState } from '../../main/worktree-ops';
import { touchDirtyMarker } from '../../main/dirty';
import { KNOWN_STATUSES } from '../../shared/types';
import { resolveSlug } from '../slug-resolver';
import { CliError, ExitCodes, emit, validation, type OutputContext } from '../output';
import { readHeader } from '../../main/header-io';
import { parseHeader } from '../../shared/header';
import { KNOWLEDGE_CHECK_TEXT } from '../../main/audit/knowledge-check';
import { assertNoExtraFlags, takeBoolFlag, type ParsedArgs } from '../parser';
import { NOUN_FLAGS } from './projects';

export async function statusCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const summary = typeof args.flags.summary === 'string' ? args.flags.summary.trim() : undefined;
  delete args.flags.summary;
  assertNoExtraFlags(args, NOUN_FLAGS);
  const sub = args.positional[0];
  if (sub === 'get') {
    const slug = args.positional[1];
    if (!slug) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects status get <slug>');
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
  const newStatus = (args.flags.status as string | undefined) ?? 'done';
  const summary = (args.flags.summary as string | undefined)?.trim();
  const noTouchDirty = args.flags['no-touch-dirty'] === true;
  for (const k of ['status', 'summary', 'no-touch-dirty']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);
  const slug = args.positional[0];
  if (!slug) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects close <slug>');
  if (!(KNOWN_STATUSES as readonly string[]).includes(newStatus)) {
    validation(`Status '${newStatus}' not in {${KNOWN_STATUSES.join(', ')}}`);
  }

  const candidate = await resolveSlug(conceptionPath, slug);
  const header = await readHeader(candidate.readmePath);
  const transition = await transitionStatus(candidate.readmePath, newStatus, { summary });

  // After closing, append the mandatory knowledge-promotion check entry.
  // This guarantees "Closed." never follows the check — the check is always last.
  const today = new Date().toISOString().slice(0, 10);
  await appendTimelineEntry(candidate.readmePath, `- ${today} — Checked knowledge promotion`);

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

/**
 * Report whether a done project still needs a knowledge-promotion check, or —
 * with `--record` — append the `Checked knowledge promotion` marker (today's
 * date) once the editorial review has actually happened.
 *
 * Without `--record` this is a *signal only* — it mutates nothing. The check
 * itself is editorial work the `/knowledge` skill performs (the three-question
 * durability test plus real `/knowledge update` entries). `--record` is the
 * mechanical, consistently-dated recorder the skill calls *after* that review,
 * so the marker is never hand-typed; `close` records it the same way at the end
 * of the close ritual. There is no mass/backfill writer — a done project gets the
 * marker only once it has actually been reviewed.
 */
export async function checkKnowledgeCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const record = takeBoolFlag(args, 'record');
  assertNoExtraFlags(args, NOUN_FLAGS);
  const slug = args.positional[0];
  if (!slug) {
    throw new CliError(
      ExitCodes.USAGE,
      'Usage: condash projects check-knowledge <slug> [--record]',
    );
  }

  const candidate = await resolveSlug(conceptionPath, slug);

  if (record) {
    const today = new Date().toISOString().slice(0, 10);
    const line = `- ${today} — ${KNOWLEDGE_CHECK_TEXT}`;
    await appendTimelineEntry(candidate.readmePath, line);
    const dirtyMarker = await touchDirtyMarker(conceptionPath, 'projects');
    emit(
      ctx,
      {
        slug: candidate.slug,
        path: candidate.readmePath,
        recorded: true,
        timelineAppended: line,
        dirtyMarkerTouched: dirtyMarker,
      },
      (d) => `${(d as { slug: string }).slug}: recorded "${KNOWLEDGE_CHECK_TEXT}" (${today}).\n`,
    );
    return;
  }

  const raw = await fs.readFile(candidate.readmePath, 'utf8');
  const status = (parseHeader(raw).status ?? '').toLowerCase();
  const isDone = status === 'done';
  const entries = parseTimelineEntries(raw);
  const lastEntry = entries.length > 0 ? entries[entries.length - 1].text : null;
  const satisfied = isDone && lastEntry !== null && lastEntry.includes(KNOWLEDGE_CHECK_TEXT);
  const needsCheck = isDone && !satisfied;

  emit(
    ctx,
    {
      slug: candidate.slug,
      path: candidate.readmePath,
      status,
      satisfied,
      needsCheck,
      lastTimelineEntry: lastEntry,
    },
    (d) => {
      const data = d as {
        slug: string;
        status: string;
        satisfied: boolean;
        lastTimelineEntry: string | null;
      };
      if (data.status !== 'done') {
        return `${data.slug}: status '${data.status}' — knowledge check applies only to done projects.\n`;
      }
      if (data.satisfied) {
        return `${data.slug}: OK — "${KNOWLEDGE_CHECK_TEXT}" is the last timeline entry.\n`;
      }
      const tail = data.lastTimelineEntry
        ? `last entry is "${data.lastTimelineEntry}"`
        : 'no timeline entries';
      return `${data.slug}: NEEDS CHECK — ${tail}. Review with /knowledge (condash projects scan-promotions ${data.slug}), promote durable findings, then record "${KNOWLEDGE_CHECK_TEXT}" as the last entry.\n`;
    },
  );
}

export async function reopenProject(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const target = (args.flags.status as string | undefined) ?? 'now';
  const summary = (args.flags.summary as string | undefined)?.trim();
  for (const k of ['status', 'summary']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);
  const slug = args.positional[0];
  if (!slug) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects reopen <slug>');
  if (!(KNOWN_STATUSES as readonly string[]).includes(target)) {
    validation(`Status '${target}' not in {${KNOWN_STATUSES.join(', ')}}`);
  }
  if (target === 'done') {
    validation(`reopen target cannot be 'done' — use \`condash projects close\` instead`);
  }
  const candidate = await resolveSlug(conceptionPath, slug);
  const header = await readHeader(candidate.readmePath);
  const previous = (header.status ?? '').toLowerCase();
  if (previous !== 'done') {
    throw new CliError(
      ExitCodes.VALIDATION,
      `Cannot reopen ${candidate.slug}: previous status is '${previous || '(none)'}', expected 'done'`,
    );
  }
  const transition = await transitionStatus(candidate.readmePath, target, { summary });
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
