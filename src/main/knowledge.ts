import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { KnowledgeNode } from '../shared/types';
import { toPosix } from '../shared/path';
import { iterUnfencedLines } from '../shared/header';
import { elide } from './index-elide';
import { matchVerifiedLine } from './knowledge-stamps';

const HIDDEN_PREFIX = /^\./;

/** Cap on a knowledge-card summary length (dashboard view). */
const MAX_CARD_SUMMARY_LENGTH = 240;

export async function readKnowledgeTree(conceptionPath: string): Promise<KnowledgeNode | null> {
  const root = join(conceptionPath, 'knowledge');
  try {
    await fs.access(root);
  } catch {
    return null;
  }
  // Track every directory's realpath as we descend. A symlink loop
  // (`a → b/`, `b/a → ../`) would otherwise hang the main process.
  return walk(root, '', 'knowledge', new Set<string>());
}

async function walk(
  absPath: string,
  relPath: string,
  name: string,
  visitedDirs: Set<string>,
): Promise<KnowledgeNode> {
  const stat = await fs.stat(absPath);
  if (stat.isFile()) {
    const meta = await readFileMeta(absPath, name);
    return {
      relPath,
      path: toPosix(absPath),
      name,
      title: meta.title,
      kind: 'file',
      summary: meta.summary,
      verifiedAt: meta.verifiedAt,
      lines: meta.lines,
    };
  }

  // Directory: dedupe by canonical path so a symlink that loops back into
  // an ancestor renders as an empty directory instead of recursing forever.
  let canonical = absPath;
  try {
    canonical = await fs.realpath(absPath);
  } catch {
    /* fall through with the lexical path */
  }
  if (visitedDirs.has(canonical)) {
    return {
      relPath,
      path: toPosix(absPath),
      name,
      title: relPath ? basename(absPath) : 'knowledge',
      kind: 'directory',
      children: [],
    };
  }
  const nextVisited = new Set(visitedDirs);
  nextVisited.add(canonical);

  const entries = await fs.readdir(absPath, { withFileTypes: true });
  const accepted = entries.filter((e) => {
    if (HIDDEN_PREFIX.test(e.name)) return false;
    if (e.isDirectory()) return true;
    return e.isFile() && e.name.toLowerCase().endsWith('.md');
  });

  const children = await Promise.all(
    accepted.map(async (entry) => {
      const childAbs = join(absPath, entry.name);
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      return walk(childAbs, childRel, entry.name, nextVisited);
    }),
  );

  children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    relPath,
    path: toPosix(absPath),
    name,
    title: relPath ? basename(absPath) : 'knowledge',
    kind: 'directory',
    children,
  };
}

interface FileMeta {
  title: string;
  summary?: string;
  verifiedAt?: string;
  lines?: number;
}

/**
 * Line count with `wc -l` semantics: the number of `\n` characters in the
 * text (a trailing newline counts; a one-line file without a trailing
 * newline reports 0).
 */
function countLines(raw: string): number {
  let lines = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

/** Read a markdown file for the card view: title (first h1), a one-paragraph
 * summary (first prose paragraph after the heading), the verification stamp
 * date (`**Verified:** YYYY-MM-DD …`), and the line count. Reads the whole
 * file — the line count always needed it, and the stamp date must agree with
 * `knowledge verify`, which judges a file on its *oldest* stamp wherever that
 * sits (condash#512). Best-effort — any failure falls back to the directory
 * name as title and leaves summary / verifiedAt undefined. */
async function readFileMeta(path: string, fallback: string): Promise<FileMeta> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return { title: fallback };
  }
  return { ...parseHead(raw, fallback), lines: countLines(raw) };
}

/**
 * Parse markdown text into card metadata. Accepts a whole file or a bounded
 * head — callers that only need the title/summary may pass a head, but
 * `verifiedAt` is only complete over the whole file.
 *
 * @param head the text to parse
 * @param fallback title to use when the text carries no `#` heading
 */
export function parseHead(head: string, fallback: string): FileMeta {
  let title: string | null = null;
  let verifiedAt: string | undefined;
  const summaryParts: string[] = [];
  let summaryDone = false;

  // Fence tracking comes from the shared iterator rather than a local
  // backtick toggle: it honours `~~~` fences and CommonMark's same-marker
  // close rule, which is what `parseVerifiedStamps` uses. A local toggle read
  // a stamp inside a `~~~` example as this file's own date, so `tree --json`
  // reported a date `knowledge verify` had correctly ignored (condash#512).
  for (const { line: raw } of iterUnfencedLines(head.split(/\r?\n/))) {
    const line = raw.trim();
    const verifiedDate = matchVerifiedLine(line);
    if (verifiedDate) {
      // Oldest wins, not first or last: a sectioned file carries one stamp
      // per section, and `knowledge verify` judges it on the oldest of them.
      // Disagreeing here is what made `tree --json` and `verify` report
      // different dates for the same file (condash#512).
      if (verifiedAt === undefined || verifiedDate < verifiedAt) verifiedAt = verifiedDate;
      if (summaryParts.length > 0) summaryDone = true;
      continue;
    }
    if (line === '') {
      if (summaryParts.length > 0) summaryDone = true;
      continue;
    }
    if (line.startsWith('#')) {
      if (title === null) title = line.replace(/^#+\s*/, '').trim() || null;
      if (summaryParts.length > 0) summaryDone = true;
      continue;
    }
    if (/^(-\s|\*\s|>\s?|\|)/.test(line)) {
      // Lists, blockquotes, tables — skip; we only want the lead prose.
      // `\*\s` rather than `\*` so `**Bold**:` keys don't trigger this.
      if (summaryParts.length > 0) summaryDone = true;
      continue;
    }
    if (!summaryDone) summaryParts.push(line);
  }

  // Strip inline markdown markers from the summary so the card reads cleanly.
  const rawSummary = summaryParts.join(' ').trim();
  const cleanSummary = rawSummary
    ? rawSummary
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    : undefined;

  const trimmedSummary =
    cleanSummary && cleanSummary.length > MAX_CARD_SUMMARY_LENGTH
      ? elide(cleanSummary, MAX_CARD_SUMMARY_LENGTH)
      : cleanSummary;

  return {
    title: title ?? fallback,
    summary: trimmedSummary,
    verifiedAt,
  };
}
