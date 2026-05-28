/**
 * `knowledge-check` audit check — projects that reached `status: done` without
 * a "Checked knowledge promotion" timeline entry as the last item.
 *
 * The invariant is simple: for any done project, the last timeline entry must
 * be "Checked knowledge promotion". If anything comes after it (including a
 * new "Closed." or "Reopened." entry), the check is stale and must be re-done.
 *
 * This replaces the old `[knowledge-recheck:pending]` / `[knowledge-recheck:done]`
 * state machine with a single, inspectable rule.
 */

import { promises as fs } from 'node:fs';
import { relative } from 'node:path';
import { findProjectReadmes } from '../walk';
import { parseHeader } from '../../shared/header';
import { parseTimelineEntries } from '../mutate';
import type { AuditIssue } from './shared';

export const KNOWLEDGE_CHECK_TEXT = 'Checked knowledge promotion';

export async function checkKnowledgeCheck(conceptionPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const readmes = await findProjectReadmes(conceptionPath);
  for (const readme of readmes) {
    const raw = await fs.readFile(readme, 'utf8').catch(() => null);
    if (raw === null) continue;
    const header = parseHeader(raw);
    if ((header.status ?? '').toLowerCase() !== 'done') continue;

    const entries = parseTimelineEntries(raw);
    if (entries.length === 0) {
      issues.push({
        check: 'knowledge-check',
        severity: 'warn',
        file: relative(conceptionPath, readme),
        line: null,
        message: `Project is done but has no timeline entries (missing "${KNOWLEDGE_CHECK_TEXT}")`,
        fix: { action: 'promote_and_record_knowledge', autoFix: false },
      });
      continue;
    }

    const last = entries[entries.length - 1];
    if (!last.text.includes(KNOWLEDGE_CHECK_TEXT)) {
      issues.push({
        check: 'knowledge-check',
        severity: 'warn',
        file: relative(conceptionPath, readme),
        line: null,
        message: `Last timeline entry is "${last.text}" — expected "${KNOWLEDGE_CHECK_TEXT}"`,
        fix: { action: 'promote_and_record_knowledge', autoFix: false },
      });
    }
  }
  return issues;
}
