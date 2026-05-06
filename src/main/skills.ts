import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { SkillNode } from '../shared/types';
import { toPosix } from '../shared/path';
import { parseHead } from './knowledge';
import { readFileHead } from './read-file-head';
import { buildShippedLookup, type ShippedLookup } from './skills-shipped';

const HIDDEN_PREFIX = /^\./;

/**
 * Read the skills tree at `<conceptionPath>/<skillsRelPath>`. Same shape as
 * Knowledge (recursive, only `.md` surfaced) plus an optional `shipped`
 * stamp on files tracked by `.condash-skills.json`. Symlink loops are
 * deduped via realpath.
 */
export async function readSkillsTree(
  conceptionPath: string,
  skillsRelPath: string,
): Promise<SkillNode | null> {
  const root = join(conceptionPath, skillsRelPath);
  try {
    await fs.access(root);
  } catch {
    return null;
  }
  const shipped = await buildShippedLookup(root);
  return walk(root, '', basename(skillsRelPath) || 'skills', new Set<string>(), shipped, root);
}

async function walk(
  absPath: string,
  relPath: string,
  name: string,
  visitedDirs: Set<string>,
  shipped: ShippedLookup,
  root: string,
): Promise<SkillNode> {
  const stat = await fs.stat(absPath);
  if (stat.isFile()) {
    const meta = await readMarkdownMeta(absPath, name);
    const shippedInfo = await shipped.lookup(absPath, relPath);
    return {
      relPath,
      path: toPosix(absPath),
      name,
      title: meta.title,
      kind: 'file',
      summary: meta.summary,
      shipped: shippedInfo ?? undefined,
    };
  }

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
      title: relPath ? basename(absPath) : name,
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
      return walk(childAbs, childRel, entry.name, nextVisited, shipped, root);
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
    title: relPath ? basename(absPath) : name,
    kind: 'directory',
    children,
  };
}

async function readMarkdownMeta(
  path: string,
  fallback: string,
): Promise<{ title: string; summary?: string }> {
  const head = await readFileHead(path);
  if (head === null) return { title: fallback };
  const meta = parseHead(head, fallback);
  return { title: meta.title, summary: meta.summary };
}
