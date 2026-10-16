import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { ResourceNode } from '../shared/types';
import { toPosix } from '../shared/path';
import { categorise, mimeFor } from '../shared/file-category';
import { DEFAULT_RESOURCES_PATH } from './config-migrate';
import { parseHead } from './knowledge';
import { readFileHead } from './read-file-head';

// Re-exported so existing importers (and `resources.test.ts`) keep reaching
// the classifier through this module; the implementation now lives in the
// node-free shared module shared with the renderer's file-open router.
export { categorise, mimeFor };

const HIDDEN_PREFIX = /^\./;

/**
 * Read the resources tree at `<conceptionPath>/resources/`. Unlike
 * `readKnowledgeTree`, every file is surfaced regardless of extension —
 * the renderer decides what to do with it based on `category`. Symlink
 * loops are deduped via realpath, same as Knowledge. The directory name
 * is hard-coded since the reframe (no `resources_path` override).
 */
export async function readResourcesTree(conceptionPath: string): Promise<ResourceNode | null> {
  const root = join(conceptionPath, DEFAULT_RESOURCES_PATH);
  try {
    await fs.access(root);
  } catch {
    return null;
  }
  return walk(root, '', DEFAULT_RESOURCES_PATH, new Set<string>());
}

async function walk(
  absPath: string,
  relPath: string,
  name: string,
  visitedDirs: Set<string>,
): Promise<ResourceNode> {
  const stat = await fs.stat(absPath);
  if (stat.isFile()) {
    const category = categorise(name);
    const mime = mimeFor(name);
    let summary: string | undefined;
    let title: string | undefined;
    if (category === 'markdown') {
      const meta = await readMarkdownMeta(absPath, name);
      title = meta.title;
      summary = meta.summary;
    }
    return {
      relPath,
      path: toPosix(absPath),
      name,
      title: title ?? name,
      kind: 'file',
      summary,
      category,
      mime,
      size: stat.size,
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
  // Skip dot-files; everything else (any extension) is included. Dirents that
  // are neither file, directory nor symlink (FIFO, socket, device) are dropped:
  // readdir-ing one throws ENOTDIR, which rejected the whole walk and blanked
  // the pane (resources/local/ accumulates FIFOs from test runs). Symlinks
  // stay so link→file/dir keep resolving below.
  const accepted = entries.filter(
    (e) => !HIDDEN_PREFIX.test(e.name) && (e.isFile() || e.isDirectory() || e.isSymbolicLink()),
  );

  const children = (
    await Promise.all(
      accepted.map(async (entry) => {
        const childAbs = join(absPath, entry.name);
        const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
        try {
          return await walk(childAbs, childRel, entry.name, nextVisited);
        } catch (err) {
          // One unreadable child (broken symlink, raced delete, EACCES dir)
          // drops alone instead of rejecting the whole tree; the warn keeps a
          // dropped subtree diagnosable.
          console.warn('[resources] skipping unreadable entry:', childAbs, err);
          return null;
        }
      }),
    )
  ).filter((child): child is ResourceNode => child !== null);

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
