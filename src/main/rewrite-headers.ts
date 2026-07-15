import { promises as fs } from 'node:fs';
import { atomicWrite } from './atomic-write';
import { withFileQueue } from './mutate-shared';
import { findProjectReadmes } from './walk';
import {
  parseHeader,
  type HeaderFields,
  FRONTMATTER_DELIMITER_LINE,
  HEADING2,
} from '../shared/header';

/**
 * One-shot migration of an item README from the legacy bold-prose header
 * (`**Key**: value` lines under the H1) to YAML frontmatter (a `---`-delimited
 * block at the top of the file, H1 below). Idempotent: a README that already
 * starts with `---` returns unchanged with `reason: 'already-yaml'`.
 *
 * The body — everything from the first `## ` heading onward — is preserved
 * verbatim. Anything between the bold-prose meta block and the first
 * subsection (rare, usually a stray paragraph) aborts the rewrite with
 * `reason: 'unexpected-content'` rather than silently dropping content;
 * the user can edit that file by hand and re-run.
 *
 * Pure (no fs) — see `rewriteHeadersInTree` for the disk-touching driver.
 */

const META_LINE_RE = /^\*\*([A-Za-z][\w -]*)\*\*\s*:\s*(.+?)\s*$/;

export type RewriteReason =
  | 'already-yaml'
  | 'no-h1'
  | 'no-meta'
  | 'unexpected-content'
  | 'rewritten';

export interface RewriteHeaderResult {
  changed: boolean;
  reason: RewriteReason;
  newContent?: string;
}

export function rewriteHeaderToYaml(raw: string): RewriteHeaderResult {
  // Shared frontmatter-open rule (see `FRONTMATTER_DELIMITER_LINE`) so this
  // dispatcher and the status writer agree on what counts as YAML shape.
  if (FRONTMATTER_DELIMITER_LINE.test(raw.split(/\r?\n/, 1)[0] ?? '')) {
    return { changed: false, reason: 'already-yaml' };
  }

  const lines = raw.split(/\r?\n/);
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';

  let h1Index = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('# ') || trimmed === '#') {
      h1Index = i;
      break;
    }
    // First non-blank line isn't the H1 — bail rather than guess.
    return { changed: false, reason: 'no-h1' };
  }
  if (h1Index === -1) return { changed: false, reason: 'no-h1' };

  let firstSectionIdx = lines.length;
  let sawMeta = false;
  for (let i = h1Index + 1; i < lines.length; i++) {
    if (HEADING2.test(lines[i])) {
      firstSectionIdx = i;
      break;
    }
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (META_LINE_RE.test(trimmed)) {
      sawMeta = true;
      continue;
    }
    // Non-meta non-blank content before the first `## ` heading — refuse to
    // rewrite, since blindly dropping or relocating it would be surprising.
    return { changed: false, reason: 'unexpected-content' };
  }

  if (!sawMeta) return { changed: false, reason: 'no-meta' };

  const fields = parseHeader(raw);
  const fmLines = renderFrontmatterLines(fields);
  const titleLine = lines[h1Index].trimEnd();
  const headerLines = [...fmLines, '', titleLine, ''];
  const bodyLines = lines.slice(firstSectionIdx);
  const newContent = [...headerLines, ...bodyLines].join(eol);

  if (newContent === raw) {
    return { changed: false, reason: 'already-yaml' };
  }
  return { changed: true, reason: 'rewritten', newContent };
}

function renderFrontmatterLines(fields: HeaderFields): string[] {
  const out: string[] = ['---'];
  if (fields.date) out.push(`date: ${fields.date}`);
  if (fields.kind) out.push(`kind: ${fields.kind}`);
  if (fields.status) out.push(`status: ${fields.status}`);
  if (fields.apps.length === 0) {
    out.push('apps: []');
  } else {
    out.push('apps:');
    for (const app of fields.apps) out.push(`  - ${yamlScalar(app)}`);
  }
  if (fields.branch) out.push(`branch: ${yamlScalar(fields.branch)}`);
  if (fields.base) out.push(`base: ${yamlScalar(fields.base)}`);
  if (fields.parent) out.push(`parent: ${yamlScalar(fields.parent)}`);
  for (const [key, value] of Object.entries(fields.extra)) {
    if (!value) continue;
    out.push(`${key}: ${yamlScalar(value)}`);
  }
  out.push('---');
  return out;
}

/** See note in `create-project.ts`'s twin — kept in lockstep. */
function yamlScalar(value: string): string {
  if (value === '') return '""';
  if (/^(?:true|false|null|yes|no|on|off|y|n)$/i.test(value)) return JSON.stringify(value);
  if (/^[A-Za-z0-9][\w. /+-]*$/.test(value) && !/^-/.test(value)) return value;
  return JSON.stringify(value);
}

export interface RewriteHeadersReport {
  /** READMEs we wrote (or would write under --dry-run). */
  rewritten: string[];
  /** Already in YAML frontmatter form — no-op. */
  alreadyYaml: string[];
  /** Skipped because the file shape was unexpected. */
  skipped: { path: string; reason: RewriteReason }[];
}

/**
 * Walk every project README under `<conception>/projects/`, attempt the
 * bold-prose → YAML migration, and report. Atomic write per file; under
 * `--dry-run`, no disk changes happen but the report still lists what
 * *would* have been rewritten.
 */
export async function rewriteHeadersInTree(
  conceptionPath: string,
  options: { dryRun?: boolean } = {},
): Promise<RewriteHeadersReport> {
  const report: RewriteHeadersReport = { rewritten: [], alreadyYaml: [], skipped: [] };
  const readmes = await findProjectReadmes(conceptionPath);
  for (const readme of readmes) {
    const raw = await fs.readFile(readme, 'utf8');
    const result = rewriteHeaderToYaml(raw);
    if (!result.changed) {
      if (result.reason === 'already-yaml') report.alreadyYaml.push(readme);
      else report.skipped.push({ path: readme, reason: result.reason });
      continue;
    }
    if (!options.dryRun && result.newContent) {
      // Serialise against the GUI's mutation writers — they queue per path
      // through `withFileQueue`, and a migration racing a step toggle on the
      // same README must not interleave (internals invariant 2).
      const newContent = result.newContent;
      await withFileQueue(readme, () => atomicWrite(readme, newContent));
    }
    report.rewritten.push(readme);
  }
  return report;
}
