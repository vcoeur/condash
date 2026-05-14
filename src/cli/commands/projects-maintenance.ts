import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { findProjectReadmes } from '../../main/walk';
import { parseHeader } from '../../shared/header';
import { appendTimelineEntry, parseTimelineEntries } from '../../main/mutate';
import { regenerateIndex, type IndexRegenReport } from '../../main/index-tree';
import { projectsStrategy } from '../../main/index-projects';
import { exec } from '../../main/exec';
import { touchDirtyMarker } from '../../main/dirty';
import {
  createProjectCore,
  type CreateProjectInput,
  type CreateProjectResult,
} from '../../main/create-project';
import { rewriteHeadersInTree, type RewriteHeadersReport } from '../../main/rewrite-headers';
import { isValidSlugTail } from '../../shared/slug';
import { resolveSlug } from '../slug-resolver';
import { CliError, ExitCodes, emit, validation, type OutputContext } from '../output';
import { assertNoExtraFlags, parseCsvFlag, type ParsedArgs } from '../parser';

// createProjectCore + CreateProjectInput + CreateProjectResult moved to
// src/main/create-project.ts in pass-10 — re-exported here so external
// consumers (if any) keep the historical import path.
export { createProjectCore };
export type { CreateProjectInput, CreateProjectResult };
export { isValidSlugTail };

const PROMOTION_RE =
  /(^|\b)(always|never|must|convention|rule|pattern|whenever|all (apps|sites|projects))\b/i;

export async function indexCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const dryRun = args.flags['dry-run'] === true;
  const rewriteAggregated = args.flags['rewrite-aggregated'] === true;
  delete args.flags['dry-run'];
  delete args.flags['rewrite-aggregated'];
  assertNoExtraFlags(args);
  const report = await regenerateIndex(conceptionPath, projectsStrategy, {
    dryRun,
    rewriteAggregated,
  });
  emit(ctx, report, formatIndexReport, [], { streamField: 'updated' });
}

function formatIndexReport(report: IndexRegenReport): string {
  const lines: string[] = [];
  lines.push(
    `Index regeneration: ${report.tree}/  (${report.dryRun ? 'dry-run' : 'wrote changes'})`,
  );
  if (report.created.length > 0) {
    lines.push(`Created (${report.created.length}):`);
    for (const p of report.created) lines.push(`  + ${p}`);
  }
  if (report.updated.length > 0) {
    lines.push(`Updated (${report.updated.length}):`);
    for (const u of report.updated) {
      const parts: string[] = [];
      if (u.added.length > 0) parts.push(`added ${u.added.length}`);
      if (u.dropped.length > 0) parts.push(`dropped ${u.dropped.length}`);
      if (u.tagsAdded.length > 0) parts.push(`tags+ ${u.tagsAdded.length}`);
      lines.push(`  ~ ${u.indexPath}  (${parts.join(', ')})`);
    }
  }
  if (report.unchanged.length > 0) {
    lines.push(`Unchanged: ${report.unchanged.length}`);
  }
  if (report.flaggedRenames.length > 0) {
    lines.push(`Suspected renames (${report.flaggedRenames.length}):`);
    for (const r of report.flaggedRenames) {
      lines.push(`  ? ${r.indexPath}  ${r.oldName}  →  ${r.newName}`);
    }
  }
  if (report.overTagDropped.length > 0) {
    lines.push(`Cap reached, dropped surplus tags (${report.overTagDropped.length}):`);
    for (const o of report.overTagDropped) {
      lines.push(`  · ${o.indexPath}  ${o.entry}  dropped: ${o.dropped.join(', ')}`);
    }
  }
  if (report.validationWarnings.length > 0) {
    lines.push(`Item validation (${report.validationWarnings.length}):`);
    for (const w of report.validationWarnings) {
      lines.push(
        `  [${w.severity}] ${relativeIfPossible(w.path, report.rootPath)}  ${w.field}: ${w.message}`,
      );
    }
  }
  if (report.dirtyClear) lines.push('Dirty marker cleared.');
  return lines.join('\n') + '\n';
}

function relativeIfPossible(path: string, rootPath: string): string {
  // rootPath is .../projects or .../knowledge; show paths relative to its
  // parent (the conception root) when possible. Falls back to the absolute
  // path when the file lives outside the root (e.g. `--path` overrides).
  if (!path.startsWith(rootPath)) return path;
  const conceptionRoot = dirname(rootPath);
  return relative(conceptionRoot, path) || path;
}

export async function createCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const apps = parseCsvFlag(args.flags.apps) ?? [];
  if (apps.length === 0) validation(`--apps is required (comma-separated, may be backticked)`);
  const input = {
    kind: String(args.flags.kind ?? '').toLowerCase(),
    slug: String(args.flags.slug ?? '').trim(),
    title: String(args.flags.title ?? '').trim(),
    apps,
    branch: typeof args.flags.branch === 'string' ? args.flags.branch.trim() || null : null,
    base: typeof args.flags.base === 'string' ? args.flags.base.trim() || null : null,
    date: typeof args.flags.date === 'string' ? args.flags.date.trim() : undefined,
    severity:
      typeof args.flags.severity === 'string' ? args.flags.severity.toLowerCase() || null : null,
    severityImpact:
      typeof args.flags['severity-impact'] === 'string'
        ? String(args.flags['severity-impact']).trim() || null
        : null,
    environment:
      typeof args.flags.environment === 'string'
        ? args.flags.environment.trim().toUpperCase() || null
        : null,
  };
  for (const k of [
    'apps',
    'kind',
    'slug',
    'title',
    'branch',
    'base',
    'date',
    'severity',
    'severity-impact',
    'environment',
  ]) {
    delete args.flags[k];
  }
  assertNoExtraFlags(args);
  const result = await createProjectCore(conceptionPath, input);
  emit(ctx, result, (data) => {
    const d = data as { relPath: string; readme: string };
    return `Created ${d.relPath}\n  README: ${d.readme}\n`;
  });
}

export async function scanPromotionsCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const slug = args.positional[0];
  if (!slug) {
    throw new CliError(ExitCodes.USAGE, 'Usage: condash projects scan-promotions <slug>');
  }
  assertNoExtraFlags(args);
  const candidate = await resolveSlug(conceptionPath, slug);
  const notesDir = join(candidate.itemDir, 'notes');
  let entries: string[];
  try {
    entries = (await fs.readdir(notesDir)).filter((n) => n.toLowerCase().endsWith('.md')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
    else throw err;
  }
  const candidates: { relPath: string; line: number; paragraph: string; match: string }[] = [];
  for (const name of entries) {
    const abs = join(notesDir, name);
    const raw = await fs.readFile(abs, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = PROMOTION_RE.exec(lines[i]);
      if (!m) continue;
      const paragraph = extractParagraph(lines, i);
      candidates.push({
        relPath: `notes/${name}`,
        line: i + 1,
        paragraph,
        match: m[0],
      });
    }
  }
  emit(
    ctx,
    {
      slug: candidate.slug,
      path: candidate.itemDir,
      candidates,
    },
    (data) => {
      const d = data as typeof data & { candidates: typeof candidates };
      if (d.candidates.length === 0) return '(no promotion candidates found)\n';
      const out: string[] = [];
      for (const c of d.candidates) {
        out.push(`${c.relPath}:${c.line}  [${c.match}]`);
        for (const para of c.paragraph.split('\n')) out.push(`  ${para}`);
      }
      return out.join('\n') + '\n';
    },
  );
}

function extractParagraph(lines: string[], hitIndex: number): string {
  let start = hitIndex;
  while (start > 0 && lines[start - 1].trim() !== '') start--;
  let end = hitIndex;
  while (end < lines.length - 1 && lines[end + 1].trim() !== '') end++;
  return lines
    .slice(start, end + 1)
    .join('\n')
    .trim();
}

export async function rewriteHeadersCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const dryRun = args.flags['dry-run'] === true;
  delete args.flags['dry-run'];
  assertNoExtraFlags(args);
  const report = await rewriteHeadersInTree(conceptionPath, { dryRun });
  emit(ctx, { ...report, dryRun }, (data) => {
    const d = data as RewriteHeadersReport & { dryRun: boolean };
    const lines: string[] = [];
    lines.push(`README header rewrite (${d.dryRun ? 'dry-run' : 'wrote changes'})`);
    if (d.rewritten.length > 0) {
      lines.push(`Rewritten (${d.rewritten.length}):`);
      for (const p of d.rewritten) lines.push(`  ~ ${relative(conceptionPath, p)}`);
    }
    if (d.alreadyYaml.length > 0) {
      lines.push(`Already YAML: ${d.alreadyYaml.length}`);
    }
    if (d.skipped.length > 0) {
      lines.push(`Skipped (${d.skipped.length}):`);
      for (const s of d.skipped) {
        lines.push(`  ! ${relative(conceptionPath, s.path)}  [${s.reason}]`);
      }
    }
    return lines.join('\n') + '\n';
  });
}

interface BackfillEntry {
  slug: string;
  readme: string;
  date: string;
  source: 'git' | 'mtime';
  appended: boolean;
}

/**
 * One-shot migration: walk every `Status: done` README; for any one that has
 * no `- <date> — Closed.` line in its `## Timeline`, append one with a date
 * derived from `git log -1` on the README (cheap heuristic — last touch
 * usually corresponds to the close), falling back to file mtime when git
 * fails (untracked file, no repo, etc.). Run with `--dry-run` to preview.
 *
 * The appended line carries a trailing `(backfill)` marker so backfilled
 * entries are distinguishable from organic close entries.
 */
export async function backfillClosed(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const dryRun = args.flags['dry-run'] === true;
  delete args.flags['dry-run'];
  assertNoExtraFlags(args);
  const readmes = await findProjectReadmes(conceptionPath);
  const candidates: BackfillEntry[] = [];
  const skipped: { slug: string; reason: string }[] = [];
  for (const readme of readmes) {
    const raw = await fs.readFile(readme, 'utf8');
    const header = parseHeader(raw);
    if ((header.status ?? '').toLowerCase() !== 'done') continue;
    const entries = parseTimelineEntries(raw);
    if (entries.some((e) => /^Closed\b/.test(e.text))) {
      skipped.push({ slug: basenameOf(readme), reason: 'already has Closed entry' });
      continue;
    }
    let date: string | null = null;
    let source: 'git' | 'mtime' = 'mtime';
    try {
      const { stdout } = await exec(
        'git',
        ['log', '-1', '--format=%ad', '--date=short', '--', readme],
        { cwd: dirname(readme) },
      );
      const trimmed = stdout.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        date = trimmed;
        source = 'git';
      }
    } catch {
      // git log failed — fall through to mtime.
    }
    if (!date) {
      try {
        const stat = await fs.stat(readme);
        date = stat.mtime.toISOString().slice(0, 10);
      } catch {
        skipped.push({ slug: basenameOf(readme), reason: 'no date source' });
        continue;
      }
    }
    candidates.push({
      slug: basenameOf(readme),
      readme,
      date,
      source,
      appended: false,
    });
  }

  if (!dryRun) {
    for (const c of candidates) {
      const line = `- ${c.date} — Closed. (backfill)`;
      await appendTimelineEntry(c.readme, line);
      c.appended = true;
    }
    if (candidates.length > 0) await touchDirtyMarker(conceptionPath, 'projects');
  }

  emit(
    ctx,
    {
      dryRun,
      candidates,
      skipped,
      totalScanned: readmes.length,
    },
    (data) => {
      const d = data as { dryRun: boolean; candidates: BackfillEntry[] };
      const lines: string[] = [];
      if (d.candidates.length === 0) {
        lines.push(
          d.dryRun ? '(no backfill candidates)' : '(no backfill candidates — nothing written)',
        );
      } else {
        lines.push(
          d.dryRun
            ? `Would append (${d.candidates.length}):`
            : `Appended (${d.candidates.length}):`,
        );
        for (const c of d.candidates) {
          lines.push(`  ${c.slug}: ${c.date} (${c.source})`);
        }
      }
      return lines.join('\n') + '\n';
    },
  );
}

function basenameOf(readmePath: string): string {
  const dir = dirname(readmePath);
  const parts = dir.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}
