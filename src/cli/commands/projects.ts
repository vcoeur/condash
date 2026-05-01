import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { findProjectReadmes } from '../../main/walk';
import { parseReadme } from '../../main/parse';
import { setStatus } from '../../main/mutate';
import { search as searchAll } from '../../main/search';
import { KNOWN_STATUSES, type SearchHit } from '../../shared/types';
import { resolveSlug } from '../slug';
import { CliError, ExitCodes, emit, validation, type OutputContext } from '../output';
import { parseHeader, readHeader, validateHeader, type HeaderFields } from '../header';
import type { ParsedArgs } from '../parser';

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
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown projects verb: ${verb}`);
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

function statusOrder(status: string): number {
  const idx = (KNOWN_STATUSES as readonly string[]).indexOf(status);
  return idx === -1 ? KNOWN_STATUSES.length : idx;
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
  );
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
      '  list        List projects (filters: --status --kind --apps --branch).',
      '  read        Read a project README + metadata.',
      '  resolve     Resolve a slug to its absolute path.',
      '  search      Search project READMEs and notes.',
      '  validate    Validate header(s) against canonical enums.',
      '  status      get|set the **Status** field.',
      '  close       Flip status to done + append closing timeline entry.',
      '',
    ].join('\n'),
  );
}
