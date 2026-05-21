/**
 * `knowledge-recheck` audit check — projects that deferred a knowledge
 * promotion and never re-ran the durability test after merge.
 *
 * The three-yes test (`knowledge/conventions.md`) promotes a finding to
 * `knowledge/` only if it (1) holds beyond the task, (2) spans more than one
 * app, and (3) stays true regardless of the PR's outcome. A finding that
 * passes #1 and #2 but fails *only* #3 — its truth is established by a
 * not-yet-merged PR — must be re-tested after merge, not dropped. That
 * deferral is recorded as a `## Timeline` entry carrying
 * `RECHECK_PENDING_MARKER`; resolving it (promote-or-drop after merge) is a
 * later entry carrying `RECHECK_DONE_MARKER`.
 *
 * A project has outstanding work iff, walking the timeline in chronological
 * (source) order, an open marker is left unmatched by a later close marker.
 * Unlike `worktrees`, this check does NOT skip `done` projects — the whole
 * point is that closing a project must not bury an unresolved recheck.
 */

import { promises as fs } from 'node:fs';
import { relative } from 'node:path';
import { findProjectReadmes } from '../walk';
import { parseTimelineEntries } from '../mutate';
import { type AuditIssue, RECHECK_PENDING_MARKER, RECHECK_DONE_MARKER } from './shared';

/** A timeline entry that opened a knowledge recheck and was never closed. */
export interface UnresolvedRecheck {
  date: string;
  text: string;
}

/**
 * Match close markers against open ones in source order. Each close marker
 * resolves the most recent still-open marker (LIFO); a close with nothing
 * open is a no-op (the count floors at zero). Returns the open markers left
 * unmatched at the end — the outstanding rechecks.
 */
export function unresolvedRechecks(
  entries: readonly { date: string; text: string }[],
): UnresolvedRecheck[] {
  const open: UnresolvedRecheck[] = [];
  for (const entry of entries) {
    if (entry.text.includes(RECHECK_PENDING_MARKER)) {
      open.push({ date: entry.date, text: entry.text });
    } else if (entry.text.includes(RECHECK_DONE_MARKER)) {
      open.pop();
    }
  }
  return open;
}

export async function checkKnowledgeRecheck(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const readmes = await findProjectReadmes(conceptionPath);
  for (const readme of readmes) {
    const raw = await fs.readFile(readme, 'utf8').catch(() => null);
    if (raw === null) continue;
    for (const open of unresolvedRechecks(parseTimelineEntries(raw))) {
      issues.push({
        check: 'knowledge-recheck',
        severity: 'warn',
        file: relative(conceptionPath, readme),
        line: null,
        message: `Deferred knowledge promotion never re-checked (opened ${open.date}): ${open.text}`,
        fix: { action: 'recheck_deferred_knowledge', autoFix: false, openedOn: open.date },
      });
    }
  }
  return issues;
}
