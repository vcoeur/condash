import { promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ItemKind, Project } from '../shared/types';

const META_LINE = /^\*\*([A-Za-z][\w -]*)\*\*\s*:\s*(.+?)\s*$/;
const HEADING2 = /^##\s/;

export async function parseReadme(path: string): Promise<Project> {
  const raw = await fs.readFile(path, 'utf8');
  const lines = raw.split(/\r?\n/);

  const title = extractTitle(lines);
  const meta = extractMetadata(lines);

  const slug = basename(dirname(path));

  return {
    slug,
    path,
    title: title ?? slug,
    kind: normaliseKind(meta.get('kind')),
    status: (meta.get('status') ?? 'backlog').toLowerCase(),
    apps: meta.get('apps'),
  };
}

function extractTitle(lines: readonly string[]): string | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '').trim() || null;
  }
  return null;
}

function extractMetadata(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  let pastTitle = false;

  for (const line of lines) {
    if (HEADING2.test(line)) break;
    if (!pastTitle) {
      if (line.trim()) pastTitle = true;
      continue;
    }
    const match = line.match(META_LINE);
    if (match) {
      const [, key, value] = match;
      out.set(key.toLowerCase(), value);
    }
  }
  return out;
}

function normaliseKind(value: string | undefined): ItemKind {
  switch ((value ?? '').toLowerCase()) {
    case 'project':
      return 'project';
    case 'incident':
      return 'incident';
    case 'document':
      return 'document';
    default:
      return 'unknown';
  }
}
