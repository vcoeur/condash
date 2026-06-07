import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { SkillNode, SkillScope } from '../shared/types';
import { toPosix } from '../shared/path';
import { parseHead } from './knowledge';
import { readFileHead } from './read-file-head';
import { buildShippedLookup, type ShippedLookup } from './skills-shipped';
import { userAgentsMdPath, userSkillsRoot } from './user-scope-paths';

const HIDDEN_PREFIX = /^\./;

/**
 * Read the skills tree for a scope. Post-reframe the Skills pane shows
 * exactly two surfaces:
 *
 *   - **Conception scope** — `<conception>/AGENTS.md` pinned at the top
 *     of the tree as a read-only callout, then `<conception>/.agents/skills/`
 *     as the tree itself.
 *   - **User scope** — `~/.config/agents/AGENTS.md` pinned at the top,
 *     then `~/.config/agents/skills/` as the tree.
 *
 * Both are agedum sources; condash never reads the compiled outputs
 * (`~/.claude/`, `<conception>/.claude/`, …). The pane is read-only in
 * both scopes — the source of truth is agedum, edited via its own flow.
 *
 * Symlink loops are deduped via realpath. Markdown files only; everything
 * else is skipped. Returns `null` only if neither the AGENTS.md nor the
 * skills root exists.
 */
export async function readSkillsTreeForScope(
  scope: SkillScope,
  conceptionPath: string,
): Promise<SkillNode | null> {
  const root = scope === 'user' ? userSkillsRoot() : join(conceptionPath, '.agents', 'skills');
  let tree: SkillNode | null = null;
  try {
    await fs.access(root);
    const shipped = await buildShippedLookup(root);
    tree = await walk(root, '', basename(root) || 'skills', new Set<string>(), shipped);
  } catch {
    tree = null;
  }
  const agentsMd = await readAgentsMdEntry(scope, conceptionPath);
  if (tree) {
    if (agentsMd) {
      tree.children = [agentsMd, ...(tree.children ?? [])];
    }
    return tree;
  }
  // No skills directory on disk, but the AGENTS.md may still exist (e.g.
  // a fresh conception that hasn't run `condash skills install` yet).
  // Surface it under a synthetic root so the pane isn't empty.
  if (agentsMd) {
    return {
      relPath: '',
      path: toPosix(root),
      name: 'skills',
      title: 'skills',
      kind: 'directory',
      children: [agentsMd],
    };
  }
  return null;
}

/** Conception-scope reader — thin wrapper kept for the existing call sites + tests. */
export function readSkillsTree(conceptionPath: string): Promise<SkillNode | null> {
  return readSkillsTreeForScope('conception', conceptionPath);
}

/** Probe the scope's AGENTS.md and return a synthetic SkillNode for it when
 *  present. The `badge: 'AGENTS'` field marks it as a read-only callout. */
async function readAgentsMdEntry(
  scope: SkillScope,
  conceptionPath: string,
): Promise<SkillNode | null> {
  const abs = scope === 'user' ? userAgentsMdPath() : join(conceptionPath, 'AGENTS.md');
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  const name = basename(abs);
  const meta = await readMarkdownMeta(abs, name);
  return {
    relPath: '__agents__/AGENTS.md',
    path: toPosix(abs),
    name,
    title: meta.title,
    kind: 'file',
    summary: meta.summary,
    badge: 'AGENTS',
  };
}

async function walk(
  absPath: string,
  relPath: string,
  name: string,
  visitedDirs: Set<string>,
  shipped: ShippedLookup,
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
    if (!e.isFile()) return false;
    return e.name.toLowerCase().endsWith('.md');
  });

  const children = await Promise.all(
    accepted.map(async (entry) => {
      const childAbs = join(absPath, entry.name);
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      return walk(childAbs, childRel, entry.name, nextVisited, shipped);
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
