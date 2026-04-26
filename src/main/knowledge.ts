import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { KnowledgeNode } from '../shared/types';

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
    return {
      relPath,
      path: absPath,
      name,
      title: await readFileTitle(absPath, name),
      kind: 'file',
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
    path: absPath,
    name,
    title: relPath ? basename(absPath) : 'knowledge',
    kind: 'directory',
    children,
  };
}

async function readFileTitle(path: string, fallback: string): Promise<string> {
  try {
    const handle = await fs.open(path);
    try {
      const { buffer, bytesRead } = await handle.read({
        buffer: Buffer.alloc(2048),
        position: 0,
      });
      const head = buffer.subarray(0, bytesRead).toString('utf8');
      for (const line of head.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        return trimmed.replace(/^#+\s*/, '').trim() || fallback;
      }
    } finally {
      await handle.close();
    }
  } catch {
    /* fall through */
  }
  return fallback;
}
