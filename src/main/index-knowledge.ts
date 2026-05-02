/**
 * Knowledge tree drafting strategy for the index regenerator.
 *
 * What it does for new entries:
 *  - File: read the body file's head (first ~8 KB), lift the first H1 title,
 *    the first prose paragraph as description, and a keyword list derived
 *    from H2 headings + the body's distinctive nouns (filename hyphen-tokens
 *    are dropped so we don't echo what the link already says).
 *  - Subdir: read the subdir's freshly-written `index.md` (the engine
 *    processes leaves first), lift its lead prose as the description, and
 *    use the aggregated descendant keyword set passed in by the engine.
 */

import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { filterTags } from './index-tag-filter';
import type { DraftResult, IndexStrategy } from './index-tree';

export const knowledgeStrategy: IndexStrategy = {
  treeName: 'knowledge',
  rootDirName: 'knowledge',
  formatChildLink: (_parent, child) =>
    child.kind === 'directory' ? `${child.name}/index.md` : child.name,
  draftFileEntry: async (_parent, child): Promise<DraftResult> => {
    const head = await readHead(child.absPath, 8192);
    const meta = parseHead(head, child.name);
    return {
      description: meta.summary ?? `(describe ${child.name})`,
      keywords: deriveFileKeywords(child.name, head),
    };
  },
  draftSubdirEntry: async (_parent, child, aggregated): Promise<DraftResult> => {
    const subIndex = join(child.absPath, 'index.md');
    let head = '';
    try {
      head = await readHead(subIndex, 8192);
    } catch {
      // Subdir has no index yet — engine processes leaves first, so this
      // should be rare. Fall back to the directory name.
    }
    const meta = parseHead(head, child.name);
    return {
      description: meta.summary ?? `(describe ${child.name}/)`,
      keywords: aggregated.length > 0 ? aggregated : deriveSubdirKeywords(head),
    };
  },
  initialTemplate: (relPath) => {
    const name = relPath === '.' ? 'Knowledge' : titleCase(basename(relPath));
    return [
      `# ${name}`,
      '',
      `(describe ${relPath === '.' ? 'this tree' : `${relPath}/`}.)`,
      '',
    ].join('\n');
  },
};

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await fs.open(path);
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read({ buffer, position: 0 });
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

interface HeadMeta {
  title: string;
  summary?: string;
  verifiedAt?: string;
}

const VERIFIED_RE = /^\*\*Verified:\*\*\s+(\d{4}-\d{2}-\d{2})/;

function parseHead(head: string, fallback: string): HeadMeta {
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
    const verified = VERIFIED_RE.exec(line);
    if (verified) {
      verifiedAt = verified[1];
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
      if (summaryParts.length > 0) summaryDone = true;
      continue;
    }
    if (!summaryDone) summaryParts.push(line);
  }

  const raw = summaryParts.join(' ').trim();
  const cleaned = raw
    ? raw
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\.$/, '')
        .trim()
    : undefined;

  const summary = cleaned && cleaned.length > 200 ? `${cleaned.slice(0, 197).trimEnd()}…` : cleaned;

  return { title: title ?? fallback, summary, verifiedAt };
}

/**
 * Pick 3-8 lowercase hyphenated keywords from a body file's head. We mine
 * H2/H3 headings (where authors put the load-bearing concepts) plus
 * inline-code names (often function/file/route names worth indexing on).
 * Filename-derived tokens are dropped so we don't echo what the link
 * already shows.
 */
function deriveFileKeywords(filename: string, head: string): string[] {
  const filenameTokens = new Set(
    filename.replace(/\.md$/, '').toLowerCase().split(/[-_]/).filter(Boolean),
  );
  const candidates: string[] = [];
  for (const line of head.split(/\r?\n/).slice(0, 80)) {
    const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (heading) {
      for (const tok of slugify(heading[1])) {
        if (!filenameTokens.has(tok)) candidates.push(tok);
      }
    }
    const codeMatches = line.match(/`[^`]+`/g);
    if (codeMatches) {
      for (const c of codeMatches) {
        for (const tok of slugify(c.replace(/`/g, ''))) {
          if (!filenameTokens.has(tok)) candidates.push(tok);
        }
      }
    }
  }
  // Apply the shared tag-quality filter (drops stop-words, dates, UUIDs, etc.)
  // and dedupe; then cap at 8.
  const cleaned = filterTags(candidates).slice(0, 8);
  if (cleaned.length === 0) {
    // Backstop: include the filename itself so the bullet has at least one
    // tag. We still pass it through the filter so junk filenames don't sneak
    // back in.
    const fallback = filename.replace(/\.md$/, '').toLowerCase();
    return filterTags([fallback]);
  }
  return cleaned;
}

function deriveSubdirKeywords(head: string): string[] {
  return deriveFileKeywords('', head);
}

function slugify(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
