import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { findProjectReadmes } from '../../main/walk';
import { parseReadme } from '../../main/parse';
import { setStatus } from '../../main/mutate';
import { search as searchAll } from '../../main/search';
import { regenerateIndex, type IndexRegenReport } from '../../main/index-tree';
import { projectsStrategy } from '../../main/index-projects';
import { checkBranchState } from '../../main/worktree-ops';
import { KNOWN_STATUSES, type SearchHit } from '../../shared/types';
import { statusOrder } from '../../shared/projects';
import { resolveSlug } from '../slug';
import { CliError, ExitCodes, emit, validation, type OutputContext } from '../output';
import { parseHeader, readHeader, validateHeader, type HeaderFields } from '../header';
import type { ParsedArgs } from '../parser';

const ITEM_KINDS = ['project', 'incident', 'document'] as const;
const SEVERITIES = ['low', 'medium', 'high'] as const;
const ENVIRONMENTS = ['PROD', 'STAGING', 'DEV'] as const;
const SLUG_TAIL_RE = /^[a-z0-9-]+$/;
const PROMOTION_RE =
  /(^|\b)(always|never|must|convention|rule|pattern|whenever|all (apps|sites|projects))\b/i;

interface ProjectListRow {
  slug: string;
  path: string;
  absPath: string;
  title: string;
  kind: string;
  status: string;
  apps: string[];
  branch: string | null;
  base: string | null;
  date: string | null;
  stepCounts: { todo: number; doing: number; done: number; dropped: number };
  deliverableCount: number;
  headerWarnings: { field: string; message: string }[];
}

export async function runProjects(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  switch (verb) {
    case null:
    case 'list':
      return verb === null ? printSubHelp() : await listProjects(args, ctx, conceptionPath);
    case 'read':
      return await readProject(args, ctx, conceptionPath);
    case 'resolve':
      return await resolveCommand(args, ctx, conceptionPath);
    case 'search':
      return await searchProjects(args, ctx, conceptionPath);
    case 'validate':
      return await validateCommand(args, ctx, conceptionPath);
    case 'status':
      return await statusCommand(args, ctx, conceptionPath);
    case 'close':
      return await closeProject(args, ctx, conceptionPath);
    case 'index':
      return await indexCommand(args, ctx, conceptionPath);
    case 'create':
      return await createCommand(args, ctx, conceptionPath);
    case 'scan-promotions':
      return await scanPromotionsCommand(args, ctx, conceptionPath);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown projects verb: ${verb}`);
  }
}

async function indexCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const dryRun = args.flags['dry-run'] === true;
  const report = await regenerateIndex(conceptionPath, projectsStrategy, { dryRun });
  emit(ctx, report, formatIndexReport);
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
  if (report.overTagTarget.length > 0) {
    lines.push(`Over-target tag count (${report.overTagTarget.length}):`);
    for (const o of report.overTagTarget) {
      lines.push(`  · ${o.indexPath}  ${o.entry}  ${o.tagCount} tags`);
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
  // parent (the conception root) when possible.
  return path.startsWith(rootPath) ? path : path;
}

async function createCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const kind = String(args.flags.kind ?? '').toLowerCase();
  if (!ITEM_KINDS.includes(kind as (typeof ITEM_KINDS)[number])) {
    validation(`--kind must be one of {${ITEM_KINDS.join(', ')}}; got '${kind || '(missing)'}'`);
  }
  const slug = String(args.flags.slug ?? '').trim();
  if (!slug || !SLUG_TAIL_RE.test(slug)) {
    validation(`--slug must match ^[a-z0-9-]+$; got '${slug}'`);
  }
  const title = String(args.flags.title ?? '').trim();
  if (!title) validation(`--title is required`);
  const apps = parseCsvFlag(args.flags.apps) ?? [];
  if (apps.length === 0) validation(`--apps is required (comma-separated, may be backticked)`);

  const branch = typeof args.flags.branch === 'string' ? args.flags.branch.trim() || null : null;
  const base = typeof args.flags.base === 'string' ? args.flags.base.trim() || null : null;
  const date = typeof args.flags.date === 'string' ? args.flags.date.trim() : isoToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    validation(`--date must be YYYY-MM-DD; got '${date}'`);
  }
  const month = date.slice(0, 7);

  let severity: string | null = null;
  let severityImpact: string | null = null;
  let environment: string | null = null;
  if (kind === 'incident') {
    severity = String(args.flags.severity ?? '').toLowerCase();
    if (!SEVERITIES.includes(severity as (typeof SEVERITIES)[number])) {
      validation(
        `--severity must be one of {${SEVERITIES.join(', ')}} for incidents; got '${severity || '(missing)'}'`,
      );
    }
    severityImpact = String(args.flags['severity-impact'] ?? '').trim() || null;
    environment =
      String(args.flags.environment ?? '')
        .trim()
        .toUpperCase() || null;
    if (environment && !ENVIRONMENTS.includes(environment as (typeof ENVIRONMENTS)[number])) {
      validation(`--environment must be one of {${ENVIRONMENTS.join(', ')}}; got '${environment}'`);
    }
  }

  const folderName = `${date}-${slug}`;
  const itemDir = join(conceptionPath, 'projects', month, folderName);
  if (await pathExists(itemDir)) {
    throw new CliError(
      ExitCodes.VALIDATION,
      `Item already exists at projects/${month}/${folderName}`,
    );
  }

  const readmeBody = renderTemplate({
    kind: kind as (typeof ITEM_KINDS)[number],
    title,
    date,
    apps,
    branch,
    base,
    severity,
    severityImpact,
    environment,
  });

  await fs.mkdir(join(itemDir, 'notes'), { recursive: true });
  const readmePath = join(itemDir, 'README.md');
  await fs.writeFile(readmePath, readmeBody, 'utf8');

  // Mark the projects index dirty so a follow-up `condash projects index` is
  // surfaced to the user.
  await touchDirtyMarker(conceptionPath, 'projects');

  emit(
    ctx,
    {
      slug: folderName,
      path: itemDir,
      relPath: relative(conceptionPath, itemDir),
      readme: readmePath,
      kind,
      title,
      date,
      apps,
      branch,
      base,
    },
    (data) => {
      const d = data as { relPath: string; readme: string };
      return `Created ${d.relPath}\n  README: ${d.readme}\n`;
    },
  );
}

interface TemplateInputs {
  kind: (typeof ITEM_KINDS)[number];
  title: string;
  date: string;
  apps: string[];
  branch: string | null;
  base: string | null;
  severity: string | null;
  severityImpact: string | null;
  environment: string | null;
}

function renderTemplate(input: TemplateInputs): string {
  const lines: string[] = [];
  lines.push(`# ${input.title}`);
  lines.push('');
  lines.push(`**Date**: ${input.date}`);
  lines.push(`**Kind**: ${input.kind}`);
  lines.push(`**Status**: now`);
  lines.push(`**Apps**: ${input.apps.map((a) => `\`${a}\``).join(', ')}`);
  if (input.branch) lines.push(`**Branch**: \`${input.branch}\``);
  if (input.base) lines.push(`**Base**: \`${input.base}\``);
  if (input.kind === 'incident') {
    if (input.environment) lines.push(`**Environment**: ${input.environment}`);
    if (input.severity) {
      const tail = input.severityImpact ? ` — ${input.severityImpact}` : '';
      lines.push(`**Severity**: ${input.severity}${tail}`);
    }
  }
  lines.push('');
  if (input.kind === 'project') {
    lines.push('## Goal');
    lines.push('');
    lines.push('<What this project aims to achieve — the user-facing outcome.>');
    lines.push('');
    lines.push('## Scope');
    lines.push('');
    lines.push('<What is in scope and what is explicitly out of scope.>');
    lines.push('');
    lines.push('## Steps');
    lines.push('');
    lines.push('- [ ] <first task>');
    lines.push('');
    lines.push('## Timeline');
    lines.push('');
    lines.push(`- ${input.date} — Project created.`);
    lines.push('');
    lines.push('## Notes');
    lines.push('');
  } else if (input.kind === 'incident') {
    lines.push('## Description');
    lines.push('');
    lines.push('<What happened — observable symptoms, scope, when it started.>');
    lines.push('');
    lines.push('## Symptoms');
    lines.push('');
    lines.push('<Bullet list of error messages, user-facing effects, log patterns.>');
    lines.push('');
    lines.push('## Analysis');
    lines.push('');
    lines.push('<Investigation findings, hypotheses, references to `notes/`.>');
    lines.push('');
    lines.push('## Root cause');
    lines.push('');
    lines.push('_Not yet identified._');
    lines.push('');
    lines.push('## Steps');
    lines.push('');
    lines.push('- [ ] <action items>');
    lines.push('');
    lines.push('## Timeline');
    lines.push('');
    lines.push(`- ${input.date} — Incident created.`);
    lines.push('');
    lines.push('## Notes');
    lines.push('');
  } else {
    lines.push('## Goal');
    lines.push('');
    lines.push('<Purpose — what this document aims to achieve or answer.>');
    lines.push('');
    lines.push('## Steps');
    lines.push('');
    lines.push('- [ ] Step 1');
    lines.push('');
    lines.push('## Timeline');
    lines.push('');
    lines.push(`- ${input.date} — Created.`);
    lines.push('');
    lines.push('## Notes');
    lines.push('');
  }
  return lines.join('\n');
}

async function scanPromotionsCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const slug = args.positional[0];
  if (!slug) {
    throw new CliError(ExitCodes.USAGE, 'Usage: condash projects scan-promotions <slug>');
  }
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listProjects(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const statusFilter = parseCsvFlag(args.flags.status);
  const kindFilter = parseCsvFlag(args.flags.kind);
  const appsFilter = parseCsvFlag(args.flags.apps);
  const branchFilter = typeof args.flags.branch === 'string' ? args.flags.branch : null;
  const sort = (args.flags.sort as string | undefined) ?? 'status';

  const readmes = await findProjectReadmes(conceptionPath);
  const rows: ProjectListRow[] = [];
  for (const readme of readmes) {
    const project = await parseReadme(readme);
    const headerFields = parseHeader(await fs.readFile(readme, 'utf8'));
    const headerWarnings = validateHeader(headerFields, readme).warnings;

    const apps = headerFields.apps;
    const branch = headerFields.branch;

    if (statusFilter && !statusFilter.includes(project.status)) continue;
    if (kindFilter && !kindFilter.includes(project.kind)) continue;
    if (appsFilter && !appsFilter.some((app) => apps.includes(app))) continue;
    if (branchFilter && branch !== branchFilter) continue;

    rows.push({
      slug: project.slug,
      path: relative(conceptionPath, readme.replace(/\/README\.md$/, '')),
      absPath: readme.replace(/\/README\.md$/, ''),
      title: project.title,
      kind: project.kind,
      status: project.status,
      apps,
      branch,
      base: headerFields.base,
      date: headerFields.date,
      stepCounts: project.stepCounts,
      deliverableCount: project.deliverableCount,
      headerWarnings,
    });
  }

  rows.sort(makeSorter(sort));
  emit(ctx, rows, formatListHuman);
}

function makeSorter(sort: string): (a: ProjectListRow, b: ProjectListRow) => number {
  if (sort === 'slug') return (a, b) => a.slug.localeCompare(b.slug);
  if (sort === 'date') return (a, b) => (b.date ?? '').localeCompare(a.date ?? '');
  return (a, b) => {
    const orderA = statusOrder(a.status);
    const orderB = statusOrder(b.status);
    if (orderA !== orderB) return orderA - orderB;
    return a.slug.localeCompare(b.slug);
  };
}

function formatListHuman(rows: ProjectListRow[]): string {
  if (rows.length === 0) return '(no projects match)\n';
  const widths = {
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    kind: Math.max(4, ...rows.map((r) => r.kind.length)),
    title: Math.min(60, Math.max(5, ...rows.map((r) => r.title.length))),
  };
  const lines: string[] = [];
  for (const r of rows) {
    const apps = r.apps.length ? `[${r.apps.join(',')}]` : '';
    const branch = r.branch ? `(${r.branch})` : '';
    const title =
      r.title.length > widths.title ? r.title.slice(0, widths.title - 1) + '…' : r.title;
    lines.push(
      `${r.status.padEnd(widths.status)}  ${r.kind.padEnd(widths.kind)}  ${title.padEnd(widths.title)}  ${r.path}  ${apps}  ${branch}`.trimEnd(),
    );
  }
  return lines.join('\n') + '\n';
}

async function readProject(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const slug = args.positional[0];
  if (!slug) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects read <slug>');
  const candidate = await resolveSlug(conceptionPath, slug);
  const project = await parseReadme(candidate.readmePath);
  const header = parseHeader(await fs.readFile(candidate.readmePath, 'utf8'));
  const data: Record<string, unknown> = {
    slug: candidate.slug,
    path: candidate.relPath,
    absPath: candidate.itemDir,
    title: project.title,
    kind: project.kind,
    status: project.status,
    date: header.date,
    apps: header.apps,
    branch: header.branch,
    base: header.base,
    summary: project.summary,
    stepCounts: project.stepCounts,
    steps: project.steps,
    deliverables: project.deliverables,
    deliverableCount: project.deliverableCount,
    extra: header.extra,
  };
  if (args.flags['with-notes']) {
    const notesDir = join(candidate.itemDir, 'notes');
    data.notes = await readNotesDir(notesDir);
  }
  emit(ctx, data, formatReadHuman);
}

async function readNotesDir(dir: string): Promise<{ relPath: string; content: string }[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: { relPath: string; content: string }[] = [];
  for (const name of entries) {
    const content = await fs.readFile(join(dir, name), 'utf8');
    out.push({ relPath: `notes/${name}`, content });
  }
  return out;
}

function formatReadHuman(data: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`# ${data.title}`);
  lines.push('');
  lines.push(`Status: ${data.status}    Kind: ${data.kind}    Date: ${data.date ?? '(none)'}`);
  if (data.apps && Array.isArray(data.apps) && data.apps.length > 0) {
    lines.push(`Apps:   ${(data.apps as string[]).join(', ')}`);
  }
  if (data.branch) lines.push(`Branch: ${data.branch}`);
  if (data.base) lines.push(`Base:   ${data.base}`);
  lines.push(`Path:   ${data.path}`);
  const counts = data.stepCounts as { todo: number; doing: number; done: number; dropped: number };
  lines.push(
    `Steps:  ${counts.todo} todo, ${counts.doing} in-progress, ${counts.done} done, ${counts.dropped} dropped`,
  );
  if (data.summary) {
    lines.push('');
    lines.push(String(data.summary));
  }
  return lines.join('\n') + '\n';
}

async function resolveCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const slug = args.positional[0];
  if (!slug) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects resolve <slug>');
  const candidate = await resolveSlug(conceptionPath, slug);
  emit(
    ctx,
    {
      slug: candidate.slug,
      path: candidate.relPath,
      absPath: candidate.itemDir,
      readmePath: candidate.readmePath,
    },
    (data) => `${(data as { absPath: string }).absPath}\n`,
  );
}

async function searchProjects(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const query = args.positional.join(' ');
  if (!query) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects search <query>');
  const limit = parseIntFlag(args.flags.limit, 50);
  const statusFilter = parseCsvFlag(args.flags.status);
  const kindFilter = parseCsvFlag(args.flags.kind);

  const results = await searchAll(conceptionPath, query);
  const projectHits = results.hits.filter((h) => h.source === 'project');

  // Annotate hits with the matched item's header so the skill can triage.
  const enriched: (SearchHit & {
    headerKind?: string;
    headerStatus?: string;
    headerApps?: string[];
  })[] = [];
  const headerCache = new Map<string, HeaderFields>();
  for (const hit of projectHits) {
    if (enriched.length >= limit) break;
    const projectPath = hit.projectPath;
    if (!projectPath) {
      enriched.push(hit);
      continue;
    }
    let header = headerCache.get(projectPath);
    if (!header) {
      header = await readHeader(join(projectPath, 'README.md')).catch(() => null as never);
      if (header) headerCache.set(projectPath, header);
    }
    if (!header) {
      enriched.push(hit);
      continue;
    }
    if (statusFilter && (!header.status || !statusFilter.includes(header.status))) continue;
    if (kindFilter && (!header.kind || !kindFilter.includes(header.kind))) continue;
    enriched.push({
      ...hit,
      headerKind: header.kind ?? undefined,
      headerStatus: header.status ?? undefined,
      headerApps: header.apps,
    });
  }

  emit(
    ctx,
    {
      query,
      hits: enriched,
      totalBeforeFilter: projectHits.length,
      truncated: results.truncated,
    },
    (data) => formatSearchHuman(data as { hits: typeof enriched; query: string }, conceptionPath),
  );
}

function formatSearchHuman(
  data: { hits: SearchHit[]; query: string },
  _conceptionPath: string,
): string {
  if (data.hits.length === 0) return `(no project matches for "${data.query}")\n`;
  const lines: string[] = [];
  for (const hit of data.hits) {
    const snippet = hit.snippets[0]?.text.replace(/\s+/g, ' ').slice(0, 120) ?? '';
    lines.push(`${hit.relPath}: ${snippet}`);
  }
  return lines.join('\n') + '\n';
}

async function validateCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const all = args.flags.all === true;
  const explicitPath = typeof args.flags.path === 'string' ? args.flags.path : null;
  const slug = args.positional[0];

  let readmes: string[];
  if (all) {
    readmes = await findProjectReadmes(conceptionPath);
  } else if (explicitPath) {
    readmes = [explicitPath];
  } else if (slug) {
    const candidate = await resolveSlug(conceptionPath, slug);
    readmes = [candidate.readmePath];
  } else {
    throw new CliError(
      ExitCodes.USAGE,
      'Usage: condash projects validate <slug> | --all | --path <readme-path>',
    );
  }

  const reports: {
    path: string;
    relPath: string;
    errors: { field: string; message: string }[];
    warnings: { field: string; message: string }[];
  }[] = [];
  let totalErrors = 0;

  for (const readme of readmes) {
    const fields = await readHeader(readme);
    const v = validateHeader(fields, readme);
    totalErrors += v.errors.length;
    reports.push({
      path: readme,
      relPath: relative(conceptionPath, readme),
      errors: v.errors,
      warnings: v.warnings,
    });
  }

  // For --json/--ndjson, emit unconditionally then choose exit code below;
  // for human, only print the report (CliError below sets exit code).
  if (ctx.json || ctx.ndjson) {
    emit(ctx, { reports, totalErrors, totalChecked: reports.length }, () => '');
  } else {
    const lines: string[] = [];
    for (const r of reports) {
      if (r.errors.length === 0 && r.warnings.length === 0) continue;
      lines.push(r.relPath);
      for (const e of r.errors) lines.push(`  ERROR  ${e.field}: ${e.message}`);
      for (const w of r.warnings) lines.push(`  warn   ${w.field}: ${w.message}`);
    }
    if (lines.length === 0) {
      process.stdout.write(
        `OK (${reports.length} README${reports.length === 1 ? '' : 's'} checked)\n`,
      );
    } else {
      process.stdout.write(lines.join('\n') + '\n');
    }
  }

  if (totalErrors > 0) {
    throw new CliError(ExitCodes.VALIDATION, `${totalErrors} validation error(s)`, {
      reports: reports.filter((r) => r.errors.length > 0),
    });
  }
}

async function statusCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
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
    const header = await readHeader(candidate.readmePath);
    const previous = header.status ?? null;
    await setStatus(candidate.readmePath, value);
    const dirtyMarker = await touchDirtyMarker(conceptionPath, 'projects');
    emit(
      ctx,
      {
        slug: candidate.slug,
        path: candidate.readmePath,
        previousStatus: previous,
        newStatus: value,
        dirtyMarkerTouched: dirtyMarker,
      },
      (d) =>
        `${(d as { previousStatus: string }).previousStatus ?? '(none)'} → ${(d as { newStatus: string }).newStatus}\n`,
    );
    return;
  }
  throw new CliError(ExitCodes.USAGE, 'Usage: condash projects status <get|set> <slug> [<value>]');
}

async function closeProject(
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

  const candidate = await resolveSlug(conceptionPath, slug);
  const header = await readHeader(candidate.readmePath);
  const previous = header.status ?? null;

  await setStatus(candidate.readmePath, newStatus);
  const today = isoToday();
  const timelineLine = summary ? `- ${today} — Closed. ${summary}.` : `- ${today} — Closed.`;
  await appendTimelineEntry(candidate.readmePath, timelineLine);

  const dirtyMarker = args.flags['no-touch-dirty']
    ? false
    : await touchDirtyMarker(conceptionPath, 'projects');

  const warnings = await leftoverBranchWarnings(conceptionPath, header.branch);

  emit(
    ctx,
    {
      slug: candidate.slug,
      path: candidate.readmePath,
      previousStatus: previous,
      newStatus,
      timelineAppended: timelineLine,
      dirtyMarkerTouched: dirtyMarker,
    },
    (d) =>
      `Closed ${(d as { slug: string }).slug}: ${(d as { previousStatus: string }).previousStatus ?? '(none)'} → ${(d as { newStatus: string }).newStatus}\n`,
    warnings,
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
    // checkBranchState reads configuration.json + queries each repo; if the
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

async function appendTimelineEntry(readmePath: string, line: string): Promise<void> {
  const raw = await fs.readFile(readmePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  let timelineHeading = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m && m[1].trim().toLowerCase() === 'timeline') {
      timelineHeading = i;
      break;
    }
  }
  if (timelineHeading === -1) {
    // Append a new ## Timeline section at the end.
    if (lines[lines.length - 1] !== '') lines.push('');
    lines.push('## Timeline');
    lines.push('');
    lines.push(line);
    if (lines[lines.length - 1] !== '') lines.push('');
    await atomicWrite(readmePath, lines.join('\n'));
    return;
  }
  // Find the end of the Timeline section (next ## or end of file).
  let end = lines.length;
  for (let i = timelineHeading + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt - 1 > timelineHeading && lines[insertAt - 1].trim() === '') {
    insertAt--;
  }
  lines.splice(insertAt, 0, line);
  await atomicWrite(readmePath, lines.join('\n'));
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${Date.now()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
}

function isoToday(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function touchDirtyMarker(
  conceptionPath: string,
  tree: 'projects' | 'knowledge',
): Promise<boolean> {
  const path = join(conceptionPath, tree, '.index-dirty');
  try {
    await fs.utimes(path, new Date(), new Date());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.writeFile(path, '', 'utf8');
    } else throw err;
  }
  return true;
}

function parseCsvFlag(value: string | boolean | undefined): string[] | null {
  if (typeof value !== 'string') return null;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntFlag(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function printSubHelp(): void {
  process.stdout.write(
    [
      'condash projects <verb> [args]',
      '',
      'Verbs:',
      '  list             List projects (filters: --status --kind --apps --branch).',
      '  read             Read a project README + metadata.',
      '  resolve          Resolve a slug to its absolute path.',
      '  search           Search project READMEs and notes.',
      '  validate         Validate header(s) against canonical enums.',
      '  status           get|set the **Status** field.',
      '  close            Flip status to done + append closing timeline entry.',
      '  index            Regenerate projects/index.md + month indexes.',
      '  create           Create a new item: --kind --slug --apps --title [--branch …].',
      '  scan-promotions  Surface durable-finding candidates inside an item’s notes/.',
      '',
    ].join('\n'),
  );
}
