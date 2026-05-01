import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { readKnowledgeTree } from '../../main/knowledge';
import type { KnowledgeNode } from '../../shared/types';
import { CliError, ExitCodes, emit, validation, type OutputContext } from '../output';
import type { ParsedArgs } from '../parser';

const DEFAULT_MAX_AGE_DAYS = 30;

export async function runKnowledge(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  switch (verb) {
    case null:
      printSubHelp();
      return;
    case 'tree':
      return await treeCommand(args, ctx, conceptionPath);
    case 'verify':
      return await verifyCommand(args, ctx, conceptionPath);
    case 'retrieve':
      return await retrieveCommand(args, ctx, conceptionPath);
    case 'stamp':
      return await stampCommand(args, ctx, conceptionPath);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown knowledge verb: ${verb}`);
  }
}

async function treeCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const depth = parseIntFlag(args.flags.depth, Infinity);
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

  emit(ctx, { stale, fresh: fresh.length, unstamped, maxAge }, (data) => {
    const d = data as { stale: StampReport[]; fresh: number; unstamped: string[] };
    const lines: string[] = [];
    if (d.stale.length === 0) {
      lines.push(`OK — ${d.fresh} stamp(s) within ${maxAge} days, ${d.unstamped.length} unstamped`);
    } else {
      lines.push(`${d.stale.length} stale stamp(s) (older than ${maxAge} days):`);
      for (const s of d.stale) {
        lines.push(`  ${s.relPath}:${s.line}  ${s.verifiedAt} (${s.ageDays}d ago)  ${s.where}`);
      }
    }
    return lines.join('\n') + '\n';
  });
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
  const query = args.positional.join(' ').trim();
  if (!query) {
    throw new CliError(ExitCodes.USAGE, 'Usage: condash knowledge retrieve <query>');
  }
  const mode = (args.flags.mode as string | undefined) ?? 'both';
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
  emit(ctx, result, (d) => formatRetrieveHuman(d as RetrieveResult));
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
  const target = args.positional[0];
  if (!target) {
    throw new CliError(
      ExitCodes.USAGE,
      'Usage: condash knowledge stamp <path> --where <where> [--date YYYY-MM-DD]',
    );
  }
  const where = args.flags.where;
  if (typeof where !== 'string' || !where.trim()) {
    throw new CliError(ExitCodes.USAGE, '--where is required (e.g. "<app>@<sha> on <branch>")');
  }
  const date = typeof args.flags.date === 'string' ? args.flags.date : isoToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    validation(`--date must be YYYY-MM-DD; got '${date}'`);
  }
  const targetPath = isAbsoluteLike(target) ? target : join(conceptionPath, target);
  const raw = await fs.readFile(targetPath, 'utf8');
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
    const insertAfter =
      typeof args.flags['insert-after'] === 'string'
        ? (args.flags['insert-after'] as string)
        : null;
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
  await atomicWrite(targetPath, lines.join('\n'));
  emit(
    ctx,
    {
      path: targetPath,
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

function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${Date.now()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
}

function parseIntFlag(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
      '',
    ].join('\n'),
  );
}
