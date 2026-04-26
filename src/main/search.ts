import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { findProjectReadmes } from './walk';
import type { SearchHit } from '../shared/types';

const MAX_SNIPPETS = 3;
const SNIPPET_RADIUS = 60;
const KNOWLEDGE_IGNORED = /(^|\/)\.[^/]+/;

/**
 * Naive grep across project + knowledge .md files. Re-walks the tree on every
 * call: simple, cache-free, plenty fast at conception scale (a few hundred
 * files of a few KB each is comfortably under 50 ms).
 */
export async function search(conceptionPath: string, query: string): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const lower = trimmed.toLowerCase();
  const projectReadmes = await findProjectReadmes(conceptionPath);
  const knowledgeFiles = await collectKnowledgeFiles(join(conceptionPath, 'knowledge'));

  const hits: SearchHit[] = [];

  for (const path of projectReadmes) {
    const hit = await tryMatch(path, lower, 'project');
    if (hit) hits.push(hit);
  }

  for (const path of knowledgeFiles) {
    const hit = await tryMatch(path, lower, 'knowledge');
    if (hit) hits.push(hit);
  }

  hits.sort((a, b) => b.matchCount - a.matchCount || a.path.localeCompare(b.path));
  return hits;
}

async function collectKnowledgeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, out);
  return out;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (KNOWLEDGE_IGNORED.test(full)) continue;
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
}

async function tryMatch(
  path: string,
  lowerQuery: string,
  source: SearchHit['source'],
): Promise<SearchHit | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
  const lower = raw.toLowerCase();
  if (!lower.includes(lowerQuery)) return null;

  const snippets: string[] = [];
  let matchCount = 0;
  let cursor = 0;
  while (true) {
    const idx = lower.indexOf(lowerQuery, cursor);
    if (idx === -1) break;
    matchCount++;
    if (snippets.length < MAX_SNIPPETS) {
      const start = Math.max(0, idx - SNIPPET_RADIUS);
      const end = Math.min(raw.length, idx + lowerQuery.length + SNIPPET_RADIUS);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < raw.length ? '…' : '';
      const snippet = raw.slice(start, end).replace(/\s+/g, ' ').trim();
      snippets.push(`${prefix}${snippet}${suffix}`);
    }
    cursor = idx + lowerQuery.length;
  }

  return {
    path,
    title: extractFirstHeading(raw) ?? path,
    source,
    matchCount,
    snippets,
  };
}

function extractFirstHeading(raw: string): string | null {
  const limit = Math.min(raw.length, 4096);
  for (const line of raw.slice(0, limit).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '').trim() || null;
  }
  return null;
}
