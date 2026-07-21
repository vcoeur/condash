import { promises as fs, type Dirent } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { ProjectFileEntry } from '../shared/types';
import { toPosix } from '../shared/path';
import { cleanRelDirPath, requirePathUnder } from './path-bounds';
import { ITEM_DIR, MONTH_DIR } from './sync/group';

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

/** Windows device names that resolve to devices rather than files — a create
 * with one of these silently misbehaves there, and condash is cross-OS. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Validate a renderer-supplied entry name for `createProjectFile` /
 * `createProjectDir`. The name keeps its case and characters after an outer
 * trim (no slug-casing — a project dir legitimately holds `Makefile` or
 * `NOTES.txt`), but rejects anything that could change the target directory,
 * hide the result, or break on another OS: empty names, path separators,
 * leading dots (the walk skips dot-entries, so a dot-named create would
 * silently vanish from the tree), trailing dots, and Windows reserved
 * device names.
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
  if (trimmed.endsWith('.')) {
    throw new Error('name must not end with a dot');
  }
  if (WINDOWS_RESERVED.test(trimmed)) {
    throw new Error(`'${trimmed}' is a reserved name`);
  }
  return trimmed;
}

/**
 * Resolve + bound the parent directory a create verb targets, given the
 * conception's `projects/` root. Three checks, in order:
 *
 *  1. the project directory (parent of `projectPath` when it names the
 *     README, the directory itself otherwise) must realpath under
 *     `projectsRoot`;
 *  2. it must be an actual **item** directory — `<month>/<dated-slug>`
 *     matching the sweeper's `MONTH_DIR`/`ITEM_DIR` shapes — so the create
 *     verbs can never scatter entries into the `projects/` root or a month
 *     bucket (the sweeper would report those `unresolved`), nor fabricate
 *     new item dirs wholesale;
 *  3. the target parent (`<projectDir>/<dirRelPath>`) must exist and
 *     realpath back under the item directory, so a symlinked subdir can't
 *     smuggle the create outside the tree.
 *
 * Kept out of the IPC layer so the whole bound is unit-testable against a
 * fixture tree; the handler supplies `projectsRoot` from settings.
 *
 * @returns The canonical absolute parent directory to create into.
 */
export async function resolveCreateParent(
  projectPath: string,
  dirRelPath: string,
  projectsRoot: string,
): Promise<string> {
  const projectDir =
    basename(projectPath).toLowerCase() === 'readme.md' ? dirname(projectPath) : projectPath;
  const projectDirReal = await requirePathUnder(projectDir, projectsRoot);
  const projectsRootReal = await requirePathUnder(projectsRoot, projectsRoot);
  const itemRel = relative(projectsRootReal, projectDirReal);
  const itemSegments = itemRel === '' ? [] : itemRel.split(sep);
  if (
    itemSegments.length !== 2 ||
    !MONTH_DIR.test(itemSegments[0]) ||
    !ITEM_DIR.test(itemSegments[1])
  ) {
    throw new Error('projectPath is not a project item directory');
  }
  const rel = cleanRelDirPath(dirRelPath, 'the project directory');
  const parentAbs = rel === '' ? projectDirReal : join(projectDirReal, rel);
  return requirePathUnder(parentAbs, projectDirReal);
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
