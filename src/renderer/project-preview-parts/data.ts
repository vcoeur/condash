// Pure tree-building logic for the project preview's Files widget.
// Dependency-free (types only) so it unit-tests without a DOM or Electron.

import type { ProjectFileEntry, ProjectFileKind } from '@shared/types';

/** Conception convention: `local/` is gitignored scratch. Rendered dimmed,
 * badged, sorted last among top-level dirs, and collapsed by default. */
export const LOCAL_DIR = 'local';

/** One node of the preview's file tree, built from the flat
 * `listProjectFiles` entries. */
export interface FileTreeNode {
  /** Last path segment (display name). */
  name: string;
  /** Path relative to the project directory — the tree's stable key. */
  relPath: string;
  /** Absolute posix path on disk. */
  path: string;
  kind: ProjectFileKind;
  /** Child nodes, sorted dirs-first (see {@link buildFileTree}). Always
   * empty for files. */
  children: FileTreeNode[];
}

/** Is `relPath` the top-level `local/` dir or anything inside it? */
export function isLocalPath(relPath: string): boolean {
  return relPath === LOCAL_DIR || relPath.startsWith(`${LOCAL_DIR}/`);
}

/** Default expansion for a dir node: top-level dirs start expanded, except
 * the gitignored `local/` scratch dir; nested dirs start collapsed. The
 * widget lays user toggles over this as per-relPath overrides. */
export function defaultExpanded(node: FileTreeNode, depth: number): boolean {
  return depth === 0 && node.name !== LOCAL_DIR;
}

/** Dirs before files; `local/` last among top-level dirs; otherwise
 * alphabetical by name. */
function compareNodes(a: FileTreeNode, b: FileTreeNode, depth: number): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  if (depth === 0 && a.kind === 'dir') {
    const aLocal = a.name === LOCAL_DIR;
    const bLocal = b.name === LOCAL_DIR;
    if (aLocal !== bLocal) return aLocal ? 1 : -1;
  }
  return a.name.localeCompare(b.name);
}

function sortTree(nodes: FileTreeNode[], depth: number): void {
  nodes.sort((a, b) => compareNodes(a, b, depth));
  for (const node of nodes) {
    if (node.children.length > 0) sortTree(node.children, depth + 1);
  }
}

/** Absolute path of an entry's parent, derived by stripping the last
 * segment — used to give a synthesized dir node a usable `path` when its
 * own entry hasn't been seen yet. */
function parentPath(childAbsPath: string): string {
  const idx = childAbsPath.lastIndexOf('/');
  return idx > 0 ? childAbsPath.slice(0, idx) : childAbsPath;
}

/**
 * Build the preview's file tree from the flat `listProjectFiles` entries.
 * The top-level `README.md` is excluded (it has its own affordances in the
 * modal). Directory entries carry the structure; a file whose parent dir
 * entry is missing (hand-built fixture, races) still gets a synthesized dir
 * node so nothing is dropped. Every level is sorted dirs-first,
 * alphabetical, with `local/` forced last among top-level dirs.
 */
export function buildFileTree(entries: readonly ProjectFileEntry[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const dirIndex = new Map<string, FileTreeNode>();

  const ensureDir = (relPath: string, absPath: string): FileTreeNode => {
    const existing = dirIndex.get(relPath);
    if (existing) return existing;
    const slash = relPath.lastIndexOf('/');
    const name = slash === -1 ? relPath : relPath.slice(slash + 1);
    const node: FileTreeNode = { name, relPath, path: absPath, kind: 'dir', children: [] };
    dirIndex.set(relPath, node);
    const siblings =
      slash === -1 ? roots : ensureDir(relPath.slice(0, slash), parentPath(absPath)).children;
    siblings.push(node);
    return node;
  };

  for (const entry of entries) {
    if (entry.relPath === 'README.md') continue;
    if (entry.kind === 'dir') {
      ensureDir(entry.relPath, entry.path);
      continue;
    }
    const slash = entry.relPath.lastIndexOf('/');
    const siblings =
      slash === -1
        ? roots
        : ensureDir(entry.relPath.slice(0, slash), parentPath(entry.path)).children;
    siblings.push({
      name: entry.name,
      relPath: entry.relPath,
      path: entry.path,
      kind: 'file',
      children: [],
    });
  }

  sortTree(roots, 0);
  return roots;
}
