/**
 * Conception-tree audit checks. Port of the legacy `.claude/scripts/audit.py`
 * to TypeScript so every conception convention check lives in one parser.
 *
 * Checks:
 *  - `lfs`        — `*.pdf|*.png|*.jpg|*.jpeg` under `projects/` not tracked
 *                   by git-lfs.
 *  - `binaries`   — same extensions over 50 kB, not in lfs (informational;
 *                   usually downstream of `lfs`).
 *  - `cross-repo` — sibling app `CLAUDE.md` references `../../conception/...`
 *                   and the target doesn't resolve.
 *  - `worktrees`  — items with an active `**Branch**` field but no on-disk
 *                   worktree at `<worktrees_path>/<branch>/`. (Only items
 *                   whose Status is not `done` are checked.)
 *  - `index`      — every directory under `knowledge/` carries an `index.md`
 *                   listing its children; flag dangling and orphan entries.
 *  - `knowledge-recheck` — projects with a deferred knowledge promotion
 *                   (a `[knowledge-recheck:pending]` timeline marker) that
 *                   was never resolved by a later `[knowledge-recheck:done]`.
 *                   Checked across all statuses, `done` included.
 *
 * Stamps live in `condash knowledge verify` — not duplicated here. The audit
 * verb composes that one too via the same envelope.
 *
 * Pure read-only. Returns `{summary, issues[]}` so the CLI can either pretty-
 * print it or hand it to the skill verbatim.
 *
 * Module shape: each check lives in `./audit/<name>.ts`, with shared types,
 * thresholds, and disk helpers in `./audit/shared.ts`. This file is the
 * thin dispatcher + public re-export — keeps the import path stable for
 * `cli/commands/audit.ts` and any other reader.
 */

import { checkBinaries } from './audit/binaries';
import { checkCrossRepo } from './audit/cross-repo';
import { checkIndex } from './audit/index-check';
import { checkKnowledgeCheck } from './audit/knowledge-check';
import { checkKnowledgeRecheck } from './audit/knowledge-recheck';
import { checkLfs } from './audit/lfs';
import { checkWorktrees } from './audit/worktrees';
import type { AuditCheckName, AuditIssue, AuditReport } from './audit/shared';

export type { AuditCheckName, AuditIssue, AuditReport } from './audit/shared';

export async function runAudit(
  conceptionPath: string,
  checks: AuditCheckName[],
): Promise<AuditReport> {
  const issues: AuditIssue[] = [];
  for (const check of checks) {
    try {
      switch (check) {
        case 'lfs':
          issues.push(...(await checkLfs(conceptionPath)));
          break;
        case 'binaries':
          issues.push(...(await checkBinaries(conceptionPath)));
          break;
        case 'cross-repo':
          issues.push(...(await checkCrossRepo(conceptionPath)));
          break;
        case 'worktrees':
          issues.push(...(await checkWorktrees(conceptionPath)));
          break;
        case 'index':
          issues.push(...(await checkIndex(conceptionPath)));
          break;
        case 'knowledge-recheck':
          issues.push(...(await checkKnowledgeRecheck(conceptionPath)));
          break;
        case 'knowledge-check':
          issues.push(...(await checkKnowledgeCheck(conceptionPath)));
          break;
        default:
          issues.push({
            check,
            severity: 'error',
            file: null,
            line: null,
            message: `unknown check: ${check}`,
            fix: { action: 'unknown_check', autoFix: false },
          });
      }
    } catch (err) {
      issues.push({
        check,
        severity: 'error',
        file: null,
        line: null,
        message: `check crashed: ${err instanceof Error ? err.message : String(err)}`,
        fix: { action: 'investigate_crash', autoFix: false },
      });
    }
  }
  const bySeverity: Record<string, number> = {};
  const byCheck: Record<string, number> = {};
  for (const i of issues) {
    bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
    byCheck[i.check] = (byCheck[i.check] ?? 0) + 1;
  }
  return {
    summary: {
      total: issues.length,
      bySeverity,
      byCheck,
      conceptionRoot: conceptionPath,
      checksRun: checks,
    },
    issues,
  };
}
