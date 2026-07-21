import { promises as fs, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { ProjectFileEntry } from '../shared/types';
import { toPosix } from '../shared/path';

/**
 * List the contents of a project directory (the directory containing
 * `readmePath`). Walks the entire subtree, emitting both files and
 * directories (`kind` distinguishes them), skipping dotfiles and
 * dot-directories. Directory entries are emitted before their contents so
 * empty dirs surface too — the preview's file tree renders real structure
 * from them instead of re-deriving it from file relPaths.
 */
export async function listProjectFiles(readmePath: string): Promise<ProjectFileEntry[]> {
  const root = dirname(readmePath);
  const out: ProjectFileEntry[] = [];
  await walk(root, '', out);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

async function walk(absDir: string, relDir: string, out: ProjectFileEntry[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(absDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolute = join(absDir, entry.name);
    const relative = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isFile()) {
      out.push({ path: toPosix(absolute), relPath: relative, name: entry.name, kind: 'file' });
      continue;
    }
    if (entry.isDirectory()) {
      out.push({ path: toPosix(absolute), relPath: relative, name: entry.name, kind: 'dir' });
      await walk(absolute, relative, out);
    }
  }
}

/**
 * Validate a renderer-supplied entry name for `createProjectFile` /
 * `createProjectDir`. The name is kept verbatim (no slug-casing — a project
 * dir legitimately holds `Makefile` or `NOTES.txt`), but rejects anything
 * that could change the target directory or hide the result: empty names,
 * path separators, and leading dots (the walk skips dot-entries, so a
 * dot-named create would silently vanish from the tree).
 */
export function requireCreatableName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('name must not be empty');
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error('name must not contain path separators');
  }
  if (trimmed.startsWith('.')) {
    throw new Error('name must not start with a dot');
  }
  if (trimmed === '..' || trimmed === '.') {
    throw new Error('name must not be a dot segment');
  }
  return trimmed;
}

/**
 * Normalise a renderer-supplied directory path relative to a project root.
 * `''` (and `.`) mean the project root itself. Rejects absolute paths and
 * any `..` traversal — mirror of `tree-mutations.ts`'s shape check; the
 * realpath bound against the project dir happens at the IPC handler.
 */
export function cleanDirRelPath(dirRelPath: string): string {
  const cleaned = normalize(dirRelPath);
  if (cleaned === '' || cleaned === '.') return '';
  if (isAbsolute(cleaned)) {
    throw new Error('dirRelPath must be relative to the project directory');
  }
  // After `normalize`, only literal `..` segments survive a traversal
  // attempt; segment-match rather than `.includes('..')` so an innocent
  // `foo..bar` filename mid-path is not flagged.
  const segments = cleaned.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new Error('dirRelPath escapes the project directory');
  }
  return cleaned;
}

/**
 * Create an empty file or directory named `name` directly inside
 * `parentDirAbs`. Refuses to overwrite an existing target (including a
 * symlink squatting on the name): the file path opens with `wx` and the dir
 * path uses a non-recursive `mkdir`, both of which fail `EEXIST`. Covered by
 * the create-path exemption to the tmp→rename invariant (internals.md §2) —
 * the target is brand-new, so there is nothing to corrupt.
 *
 * @param parentDirAbs Absolute, already bounds-checked parent directory.
 * @param name Already-validated entry name (see {@link requireCreatableName}).
 * @param kind Whether to create a file or a directory.
 * @returns The new entry's absolute posix path.
 */
export async function createProjectEntry(
  parentDirAbs: string,
  name: string,
  kind: 'file' | 'dir',
): Promise<string> {
  const target = join(parentDirAbs, name);
  // Defence-in-depth: the join must not have escaped the parent dir. The
  // validators above already reject separators, but re-check before writing.
  if (basename(target) !== name) {
    throw new Error('invalid entry name');
  }
  try {
    if (kind === 'file') {
      await fs.writeFile(target, '', { encoding: 'utf8', flag: 'wx' });
    } else {
      await fs.mkdir(target);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`'${name}' already exists`);
    }
    throw err;
  }
  return toPosix(target);
}
