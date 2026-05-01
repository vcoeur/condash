import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { KnowledgeNode } from '../shared/types';
import { toPosix } from '../shared/path';

const HIDDEN_PREFIX = /^\./;

export async function readKnowledgeTree(conceptionPath: string): Promise<KnowledgeNode | null> {
  const root = join(conceptionPath, 'knowledge');
  try {
    await fs.access(root);
  } catch {
    return null;
  }
  return walk(root, '', 'knowledge');
}

async function walk(absPath: string, relPath: string, name: string): Promise<KnowledgeNode> {
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
    };
  }

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
      return walk(childAbs, childRel, entry.name);
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
}

/** Parse the head of a markdown file for the card view: title (first h1),
 * a one-paragraph summary (first prose paragraph after the heading), and
 * the verification stamp date (`**Verified:** YYYY-MM-DD …`). Reads up to
 * 8 KB so we capture the verified line even when it sits below a long
 * lead paragraph. Best-effort — any failure falls back to the directory
 * name as title and leaves summary / verifiedAt undefined. */
async function readFileMeta(path: string, fallback: string): Promise<FileMeta> {
  try {
    const handle = await fs.open(path);
    try {
      const { buffer, bytesRead } = await handle.read({
        buffer: Buffer.alloc(8192),
        position: 0,
      });
      const head = buffer.subarray(0, bytesRead).toString('utf8');
      return parseHead(head, fallback);
    } finally {
      await handle.close();
    }
  } catch {
    return { title: fallback };
  }
}

const VERIFIED_RE = /^\*\*Verified:\*\*\s+(\d{4}-\d{2}-\d{2})/;

export function parseHead(head: string, fallback: string): FileMeta {
  const lines = head.split(/\r?\n/);
  let title: string | null = null;
  let verifiedAt: string | undefined;
  const summaryParts: string[] = [];
  let summaryDone = false;
  let inFence = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const verifiedMatch = VERIFIED_RE.exec(line);
    if (verifiedMatch) {
      verifiedAt = verifiedMatch[1];
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
    cleanSummary && cleanSummary.length > 240
      ? `${cleanSummary.slice(0, 237).trimEnd()}…`
      : cleanSummary;

  return {
    title: title ?? fallback,
    summary: trimmedSummary,
    verifiedAt,
  };
}
