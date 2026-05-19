import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readKnowledgeTree } from '../../main/knowledge';
import { regenerateIndex, type IndexRegenReport } from '../../main/index-tree';
import { knowledgeStrategy } from '../../main/index-knowledge';
import { atomicWrite } from '../../main/atomic-write';
import { isoToday } from '../../shared/iso-today';
import type { KnowledgeNode } from '../../shared/types';
import { CliError, ExitCodes, emit, validation, type OutputContext } from '../output';
import { assertNoExtraFlags, parseIntFlag, type ParsedArgs } from '../parser';
import { UNIVERSAL_FOOTER } from '../help';

const DEFAULT_MAX_AGE_DAYS = 30;

const KNOWN_FLAGS_TREE = ['depth'] as const;
const KNOWN_FLAGS_VERIFY = ['max-age'] as const;
const KNOWN_FLAGS_RETRIEVE = ['mode'] as const;
const KNOWN_FLAGS_STAMP = ['where', 'date', 'insert-after'] as const;
const KNOWN_FLAGS_INDEX = ['dry-run', 'rewrite-aggregated'] as const;

const NOUN_FLAGS: readonly string[] = [
  ...new Set<string>([
    ...KNOWN_FLAGS_TREE,
    ...KNOWN_FLAGS_VERIFY,
    ...KNOWN_FLAGS_RETRIEVE,
    ...KNOWN_FLAGS_STAMP,
    ...KNOWN_FLAGS_INDEX,
  ]),
];

export async function runKnowledge(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
  universalHelp = false,
): Promise<void> {
  if (verb === 'help') {
    printHelp(args.positional[0] ?? null);
    return;
  }
  if (universalHelp) {
    printHelp(verb);
    return;
  }
  switch (verb) {
    case null:
      printHelp(null);
      return;
    case 'tree':
      return await treeCommand(args, ctx, conceptionPath);
    case 'verify':
      return await verifyCommand(args, ctx, conceptionPath);
    case 'retrieve':
      return await retrieveCommand(args, ctx, conceptionPath);
    case 'stamp':
      return await stampCommand(args, ctx, conceptionPath);
    case 'index':
      return await indexCommand(args, ctx, conceptionPath);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown knowledge verb: ${verb}`);
  }
}

async function indexCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const dryRun = args.flags['dry-run'] === true;
  const rewriteAggregated = args.flags['rewrite-aggregated'] === true;
  delete args.flags['dry-run'];
  delete args.flags['rewrite-aggregated'];
  assertNoExtraFlags(args, NOUN_FLAGS);
  const report = await regenerateIndex(conceptionPath, knowledgeStrategy, {
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
  if (report.unchanged.length > 0) lines.push(`Unchanged: ${report.unchanged.length}`);
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
  if (report.rewriteAggregated) {
    lines.push('Mode: --rewrite-aggregated (subdir bullets re-derived from descendants).');
  }
  if (report.dirtyClear) lines.push('Dirty marker cleared.');
  return lines.join('\n') + '\n';
}

async function treeCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const depth = parseIntFlag(args.flags.depth, Infinity);
  delete args.flags.depth;
  assertNoExtraFlags(args, NOUN_FLAGS);
  const root = await readKnowledgeTree(conceptionPath);
  if (!root) throw new CliError(ExitCodes.NOT_FOUND, 'No knowledge/ tree found');
  const trimmed = trimDepth(root, depth);
  emit(ctx, trimmed, formatTreeHuman);
}

function trimDepth(node: KnowledgeNode, depth: number, current = 0): KnowledgeNode {
  if (current >= depth || !node.children) {
    return { ...node, children: undefined };
  }
  return {
    ...node,
    children: node.children.map((c) => trimDepth(c, depth, current + 1)),
  };
}

function formatTreeHuman(node: KnowledgeNode): string {
  const lines: string[] = [];
  walkForHuman(node, '', true, true, lines);
  return lines.join('\n') + '\n';
}

function walkForHuman(
  node: KnowledgeNode,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  lines: string[],
): void {
  const branchChar = isRoot ? '' : isLast ? '└── ' : '├── ';
  const stamp = node.verifiedAt ? `  (Verified ${node.verifiedAt})` : '';
  const suffix = node.kind === 'directory' && node.relPath !== '' ? '/' : '';
  lines.push(`${prefix}${branchChar}${node.name}${suffix}${stamp}`);
  if (!node.children) return;
  const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
  node.children.forEach((c, i) => {
    walkForHuman(c, childPrefix, i === node.children!.length - 1, false, lines);
  });
}

interface StampReport {
  path: string;
  relPath: string;
  line: number;
  verifiedAt: string;
  where: string;
  ageDays: number;
}

async function verifyCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const maxAge = parseIntFlag(args.flags['max-age'], DEFAULT_MAX_AGE_DAYS);
  delete args.flags['max-age'];
  assertNoExtraFlags(args, NOUN_FLAGS);
  const knowledgeRoot = join(conceptionPath, 'knowledge');
  const files = await collectKnowledgeFiles(knowledgeRoot);

  const stale: StampReport[] = [];
  const fresh: StampReport[] = [];
  const unstamped: string[] = [];
  const today = new Date();

  for (const path of files) {
    const raw = await fs.readFile(path, 'utf8');
    const lines = raw.split(/\r?\n/);
    let stampLine = -1;
    let verifiedAt: string | null = null;
    let where = '';
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\*\*Verified:\*\*\s+(\d{4}-\d{2}-\d{2})\b\s*(.*)$/);
      if (m) {
        stampLine = i + 1;
        verifiedAt = m[1];
        where = m[2].trim();
        break;
      }
    }
    if (!verifiedAt) {
      unstamped.push(relative(conceptionPath, path));
      continue;
    }
    const ageDays = daysBetween(verifiedAt, today);
    const report: StampReport = {
      path,
      relPath: relative(conceptionPath, path),
      line: stampLine,
      verifiedAt,
      where,
      ageDays,
    };
    if (ageDays > maxAge) stale.push(report);
    else fresh.push(report);
  }

  // Materialise stale stamps as audit-shaped issues so wrapping skills (e.g.
  // /tidy) consume audit + verify with one shape. autoFix is hardcoded to
  // false: a stale stamp means "human reread the source and re-confirmed",
  // never "bump the date for me".
  const issues = stale.map((s) => ({
    check: 'stale_verification',
    severity: 'warn' as const,
    file: s.relPath,
    line: s.line,
    message: `Verification stamp from ${s.verifiedAt} (${s.ageDays}d ago) is older than ${maxAge}-day threshold`,
    fix: {
      action: 'flag_for_user_review',
      autoFix: false,
      verifiedAt: s.verifiedAt,
      ageDays: s.ageDays,
      where: s.where,
    },
  }));

  emit(
    ctx,
    { stale, fresh: fresh.length, unstamped, maxAge, issues },
    (data) => {
      const d = data as { stale: StampReport[]; fresh: number; unstamped: string[] };
      const lines: string[] = [];
      if (d.stale.length === 0) {
        lines.push(
          `OK — ${d.fresh} stamp(s) within ${maxAge} days, ${d.unstamped.length} unstamped`,
        );
      } else {
        lines.push(`${d.stale.length} stale stamp(s) (older than ${maxAge} days):`);
        for (const s of d.stale) {
          lines.push(`  ${s.relPath}:${s.line}  ${s.verifiedAt} (${s.ageDays}d ago)  ${s.where}`);
        }
      }
      return lines.join('\n') + '\n';
    },
    [],
    { streamField: 'stale' },
  );
}

interface RetrieveResult {
  triageMatches: TriageMatch[];
  grepMatches: GrepMatch[];
  warnings: string[];
}

interface TriageMatch {
  path: string;
  relPath: string;
  description: string;
  keywords: string[];
  matchedKeywords: string[];
  source: 'index';
}

interface GrepMatch {
  path: string;
  relPath: string;
  line: number;
  snippet: string;
}

async function retrieveCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const modeFlag = args.flags.mode;
  delete args.flags.mode;
  assertNoExtraFlags(args, NOUN_FLAGS);
  const query = args.positional.join(' ').trim();
  if (!query) {
    throw new CliError(ExitCodes.USAGE, 'Usage: condash knowledge retrieve <query>');
  }
  const mode = (modeFlag as string | undefined) ?? 'both';
  if (!['triage', 'grep', 'both'].includes(mode)) {
    throw new CliError(ExitCodes.USAGE, `--mode must be triage|grep|both`);
  }

  const knowledgeRoot = join(conceptionPath, 'knowledge');
  const triage: TriageMatch[] = [];
  const grep: GrepMatch[] = [];

  if (mode === 'triage' || mode === 'both') {
    const indexEntries = await collectIndexEntries(knowledgeRoot, conceptionPath);
    const lowered = query.toLowerCase();
    const tokens = lowered.split(/\s+/).filter(Boolean);
    for (const entry of indexEntries) {
      const matched = entry.keywords.filter((k) => tokens.some((t) => k.includes(t)));
      const descMatch = tokens.some((t) => entry.description.toLowerCase().includes(t));
      if (matched.length > 0 || descMatch) {
        triage.push({ ...entry, matchedKeywords: matched });
      }
    }
  }

  if (mode === 'grep' || (mode === 'both' && triage.length === 0)) {
    const files = await collectKnowledgeFiles(knowledgeRoot);
    const re = new RegExp(escapeRegex(query), 'i');
    for (const path of files) {
      const content = await fs.readFile(path, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          grep.push({
            path,
            relPath: relative(conceptionPath, path),
            line: i + 1,
            snippet: lines[i].slice(0, 200),
          });
        }
      }
    }
  }

  const result: RetrieveResult = { triageMatches: triage, grepMatches: grep, warnings: [] };
  emit(ctx, result, (d) => formatRetrieveHuman(d as RetrieveResult), [], {
    streamField: 'triageMatches',
  });
}

function formatRetrieveHuman(r: RetrieveResult): string {
  const lines: string[] = [];
  if (r.triageMatches.length === 0 && r.grepMatches.length === 0) {
    return '(no matches)\n';
  }
  if (r.triageMatches.length > 0) {
    lines.push(`Triage matches (${r.triageMatches.length}):`);
    for (const m of r.triageMatches) {
      lines.push(`  ${m.relPath}  [${m.matchedKeywords.join(', ')}]`);
      if (m.description) lines.push(`    ${m.description}`);
    }
  }
  if (r.grepMatches.length > 0) {
    lines.push(`Grep matches (${r.grepMatches.length}):`);
    for (const g of r.grepMatches.slice(0, 50)) {
      lines.push(`  ${g.relPath}:${g.line}  ${g.snippet}`);
    }
  }
  return lines.join('\n') + '\n';
}

interface IndexEntry {
  path: string;
  relPath: string;
  description: string;
  keywords: string[];
  source: 'index';
}

async function collectIndexEntries(
  knowledgeRoot: string,
  conceptionPath: string,
): Promise<IndexEntry[]> {
  const indexFiles = await collectIndexMdFiles(knowledgeRoot);
  const entries: IndexEntry[] = [];
  // Bullet line: - [`name`](link) — *italic description.* `[k1, k2, …]`
  const BULLET = /^-\s+\[[^\]]+\]\(([^)]+)\)\s+[—\-]\s+\*([^*]+)\*\s*`?\[?([^\]`]*)\]?`?/;
  for (const indexPath of indexFiles) {
    const raw = await fs.readFile(indexPath, 'utf8');
    const dir = relative(conceptionPath, indexPath).replace(/\/index\.md$/, '');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(BULLET);
      if (!m) continue;
      const link = m[1].replace(/\/index\.md$/, '/');
      const description = m[2].trim().replace(/\.$/, '');
      const keywords = m[3]
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      entries.push({
        path: join(conceptionPath, dir, link),
        relPath: `${dir}/${link}`,
        description,
        keywords,
        source: 'index',
      });
    }
  }
  return entries;
}

async function collectIndexMdFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walkDir(root, async (path, isDir) => {
    if (!isDir && path.endsWith('/index.md')) out.push(path);
  });
  return out;
}

async function collectKnowledgeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walkDir(root, async (path, isDir) => {
    if (!isDir && path.toLowerCase().endsWith('.md') && !path.endsWith('/index.md')) {
      out.push(path);
    }
  });
  return out;
}

async function walkDir(
  dir: string,
  visit: (path: string, isDir: boolean) => Promise<void>,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await visit(full, true);
      await walkDir(full, visit);
    } else if (entry.isFile()) {
      await visit(full, false);
    }
  }
}

async function stampCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const where = args.flags.where;
  const dateFlag = args.flags.date;
  const insertAfter =
    typeof args.flags['insert-after'] === 'string' ? (args.flags['insert-after'] as string) : null;
  for (const k of ['where', 'date', 'insert-after']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);
  const target = args.positional[0];
  if (!target) {
    throw new CliError(
      ExitCodes.USAGE,
      'Usage: condash knowledge stamp <path> --where <where> [--date YYYY-MM-DD]',
    );
  }
  if (typeof where !== 'string' || !where.trim()) {
    throw new CliError(ExitCodes.USAGE, '--where is required (e.g. "<app>@<sha> on <branch>")');
  }
  const date = typeof dateFlag === 'string' ? dateFlag : isoToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    validation(`--date must be YYYY-MM-DD; got '${date}'`);
  }
  const targetPath = isAbsoluteLike(target) ? target : join(conceptionPath, target);
  // The stamp writes a body file — refuse anywhere outside the conception
  // tree so a `--target ../../etc/passwd` argument can't prepend a Verified
  // line wherever fs lets us. Lexical resolve isn't enough: a symlink under
  // the tree pointing at /etc/passwd would pass the rel-check but fs would
  // follow the symlink on write. realpath both sides; if the file doesn't
  // exist yet, realpath the parent so the bound is still enforced.
  const resolvedTarget = resolve(targetPath);
  const resolvedRoot = await fs.realpath(resolve(conceptionPath));
  let realTarget: string;
  try {
    realTarget = await fs.realpath(resolvedTarget);
  } catch {
    const parent = await fs.realpath(resolve(resolvedTarget, '..')).catch(() => null);
    if (!parent) {
      throw new CliError(
        ExitCodes.VALIDATION,
        `--target parent directory does not exist: ${target}`,
      );
    }
    realTarget = join(parent, relative(resolve(resolvedTarget, '..'), resolvedTarget));
  }
  const relReal = relative(resolvedRoot, realTarget);
  if (relReal.startsWith('..') || join(resolvedRoot, relReal) !== realTarget) {
    throw new CliError(
      ExitCodes.VALIDATION,
      `--target must resolve inside the conception tree: ${target}`,
    );
  }
  // Read AND write against the canonical (realpath'd) path, not the
  // renderer-supplied `targetPath`: otherwise a symlink that resolved
  // safely under `resolvedRoot` would still let fs follow it to a
  // different inode on the actual I/O, slipping past the bounds check.
  const raw = await fs.readFile(realTarget, 'utf8');
  const stampLine = `**Verified:** ${date} ${where.trim()}`;
  const lines = raw.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\*\*Verified:\*\*/.test(lines[i])) {
      lines[i] = stampLine;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (insertAfter) {
      let inserted = false;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^#+\s+(.+)$/);
        if (m && m[1].trim() === insertAfter) {
          lines.splice(i + 1, 0, '', stampLine);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        throw new CliError(
          ExitCodes.NOT_FOUND,
          `Heading '${insertAfter}' not found in ${targetPath}`,
        );
      }
    } else {
      lines.unshift(stampLine, '');
    }
  }
  await atomicWrite(realTarget, lines.join('\n'));
  emit(
    ctx,
    {
      path: realTarget,
      verifiedAt: date,
      where: where.trim(),
      replaced,
    },
    (d) =>
      `${(d as { replaced: boolean }).replaced ? 'Replaced' : 'Inserted'} stamp in ${(d as { path: string }).path}\n`,
  );
}

function daysBetween(iso: string, today: Date): number {
  const [y, m, d] = iso.split('-').map(Number);
  const stamp = new Date(Date.UTC(y, m - 1, d));
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.floor((now - stamp.getTime()) / (1000 * 60 * 60 * 24)));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAbsoluteLike(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\\/.test(p);
}

function printHelp(verb: string | null): void {
  switch (verb) {
    case 'tree':
      process.stdout.write(
        [
          'condash knowledge tree [--depth N]',
          '',
          'Hierarchical view of knowledge/.',
          '',
          'Optional:',
          '  --depth   Cap recursion at N levels (default: unlimited).',
          '',
          'Examples:',
          '  condash knowledge tree',
          '  condash knowledge tree --depth 2 --json',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'verify':
      process.stdout.write(
        [
          'condash knowledge verify [--max-age N]',
          '',
          'Audit **Verified:** stamps; report any older than --max-age days.',
          '',
          'Optional:',
          `  --max-age   Threshold in days (default: ${DEFAULT_MAX_AGE_DAYS}).`,
          '',
          'Examples:',
          '  condash knowledge verify',
          '  condash knowledge verify --max-age 60 --json',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'retrieve':
      process.stdout.write(
        [
          'condash knowledge retrieve <query> [--mode <mode>]',
          '',
          'Match a query against index.md keywords; falls back to grep.',
          '',
          'Optional:',
          '  --mode    triage | grep | both   (default: both)',
          '',
          'Examples:',
          '  condash knowledge retrieve "session cookie"',
          '  condash knowledge retrieve gdpr --mode triage --json',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'stamp':
      process.stdout.write(
        [
          'condash knowledge stamp <path> --where <where> [--date YYYY-MM-DD] [--insert-after <heading>]',
          '',
          'Idempotently write a **Verified:** line into a file.',
          '',
          'Required:',
          '  --where         Provenance string (e.g. "condash@abc1234 on main").',
          '',
          'Optional:',
          '  --date          Stamp date (default: today).',
          '  --insert-after  Heading after which to insert when no stamp exists yet.',
          '',
          'Examples:',
          '  condash knowledge stamp knowledge/internal/condash.md --where "condash@abc1234 on main"',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    case 'index':
      process.stdout.write(
        [
          'condash knowledge index [--dry-run] [--rewrite-aggregated]',
          '',
          'Regenerate every knowledge/**/index.md.',
          '',
          'Optional:',
          '  --dry-run                Preview without writing.',
          '  --rewrite-aggregated     One-shot migration: re-derive every subdir bullet',
          '                           from descendants and mark drafted.',
          '',
          'Examples:',
          '  condash knowledge index',
          '  condash knowledge index --dry-run --json',
          '',
          UNIVERSAL_FOOTER,
          '',
        ].join('\n'),
      );
      return;
    default:
      printSubHelp();
  }
}

function printSubHelp(): void {
  process.stdout.write(
    [
      'condash knowledge <verb> [args]',
      '',
      'Verbs:',
      '  tree        Hierarchical view of knowledge/ (with --depth N).',
      '  verify      Audit **Verified:** stamps older than --max-age (default 30).',
      '  retrieve    Match a query against index.md keywords; falls back to grep.',
      '  stamp       Idempotently write a **Verified:** line into a file.',
      '  index       Regenerate every knowledge/**/index.md.',
      '',
      UNIVERSAL_FOOTER,
      '',
    ].join('\n'),
  );
}
