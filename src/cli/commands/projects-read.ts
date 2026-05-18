import { promises as fs } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { findProjectReadmes } from '../../main/walk';
import { parseReadmeWithHeader } from '../../main/parse';
import { search as searchAll } from '../../main/search';
import { type SearchHit } from '../../shared/types';
import { statusOrder } from '../../shared/projects';
import { resolveSlug } from '../slug-resolver';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { parseHeader, validateHeader, validateBody, type HeaderFields } from '../../shared/header';
import { readHeader } from '../../main/header-io';
import { assertNoExtraFlags, parseCsvFlag, parseIntFlag, type ParsedArgs } from '../parser';
import { NOUN_FLAGS } from './projects';

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
  closedAt: string | null;
  stepCounts: { todo: number; doing: number; done: number; dropped: number };
  deliverableCount: number;
  headerWarnings: { field: string; message: string }[];
}

export async function listProjects(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const statusFilter = parseCsvFlag(args.flags.status);
  const kindFilter = parseCsvFlag(args.flags.kind);
  const appsFilter = parseCsvFlag(args.flags.apps);
  const branchFilter = typeof args.flags.branch === 'string' ? args.flags.branch : null;
  const sort = (args.flags.sort as string | undefined) ?? 'status';
  for (const k of ['status', 'kind', 'apps', 'branch', 'sort']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);

  const readmes = await findProjectReadmes(conceptionPath);
  const rows: ProjectListRow[] = [];
  for (const readme of readmes) {
    const { project, header: headerFields } = await parseReadmeWithHeader(readme);
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
      closedAt: project.closedAt,
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

export async function readProject(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const withNotes = args.flags['with-notes'] === true;
  delete args.flags['with-notes'];
  assertNoExtraFlags(args, NOUN_FLAGS);
  const slug = args.positional[0];
  if (!slug) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects read <slug>');
  const candidate = await resolveSlug(conceptionPath, slug);
  const { project, header } = await parseReadmeWithHeader(candidate.readmePath);
  const data: Record<string, unknown> = {
    slug: candidate.slug,
    path: candidate.relPath,
    absPath: candidate.itemDir,
    title: project.title,
    kind: project.kind,
    status: project.status,
    date: header.date,
    closedAt: project.closedAt,
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
  if (withNotes) {
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

export async function resolveCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  assertNoExtraFlags(args, NOUN_FLAGS);
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

export async function searchProjects(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const limit = parseIntFlag(args.flags.limit, 50);
  const statusFilter = parseCsvFlag(args.flags.status);
  const kindFilter = parseCsvFlag(args.flags.kind);
  for (const k of ['limit', 'status', 'kind']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);
  const query = args.positional.join(' ');
  if (!query) throw new CliError(ExitCodes.USAGE, 'Usage: condash projects search <query>');

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
    [],
    { streamField: 'hits' },
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

export async function validateCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const all = args.flags.all === true;
  const explicitPath = typeof args.flags.path === 'string' ? args.flags.path : null;
  const slug = args.positional[0];
  for (const k of ['all', 'path']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);

  let readmes: string[];
  if (all) {
    readmes = await findProjectReadmes(conceptionPath);
  } else if (explicitPath) {
    // Path-traversal guard: --path is the one validate input where the
    // skill/user passes an arbitrary filesystem path, so we resolve and
    // require it to live under <conception>/projects/. Without this, a
    // skill bug or shell typo could point validate at an arbitrary
    // README on disk and we'd dutifully open it.
    const resolved = resolve(conceptionPath, explicitPath);
    const projectsRoot = resolve(conceptionPath, 'projects') + sep;
    if (!resolved.startsWith(projectsRoot)) {
      throw new CliError(
        ExitCodes.USAGE,
        `--path must point inside <conception>/projects/ (got ${explicitPath})`,
      );
    }
    readmes = [resolved];
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
    const raw = await fs.readFile(readme, 'utf8');
    const fields = parseHeader(raw);
    const v = validateHeader(fields, readme);
    const b = validateBody(raw);
    totalErrors += v.errors.length + b.errors.length;
    reports.push({
      path: readme,
      relPath: relative(conceptionPath, readme),
      errors: [...v.errors, ...b.errors],
      warnings: [...v.warnings, ...b.warnings],
    });
  }

  // Single envelope discipline: on errors, throw CliError so the dispatcher
  // emits ONE failure envelope carrying the reports — without this branch,
  // the success-path emit() would write a success envelope first and
  // consumers would see two JSON objects on a failed run (the previous bug
  // the v2.10.17 review caught).
  if (totalErrors > 0) {
    throw new CliError(ExitCodes.VALIDATION, `${totalErrors} validation error(s)`, {
      reports: reports.filter((r) => r.errors.length > 0),
      totalChecked: reports.length,
    });
  }

  emit(
    ctx,
    { reports, totalErrors, totalChecked: reports.length },
    (data) => {
      const d = data as { reports: typeof reports };
      const lines: string[] = [];
      for (const r of d.reports) {
        if (r.errors.length === 0 && r.warnings.length === 0) continue;
        lines.push(r.relPath);
        for (const e of r.errors) lines.push(`  ERROR  ${e.field}: ${e.message}`);
        for (const w of r.warnings) lines.push(`  warn   ${w.field}: ${w.message}`);
      }
      if (lines.length === 0) {
        return `OK (${d.reports.length} README${d.reports.length === 1 ? '' : 's'} checked)\n`;
      }
      return lines.join('\n') + '\n';
    },
    [],
    { streamField: 'reports' },
  );
}
