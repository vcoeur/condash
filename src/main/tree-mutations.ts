import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, extname, join, normalize } from 'node:path';
import { dialog } from 'electron';
import type { TreeRoot } from '../shared/types';
import { toPosix } from '../shared/path';
import { readSettings } from './settings';
import { DEFAULT_RESOURCES_PATH } from './config-schema';
import { requirePathUnder } from './path-bounds';

/**
 * Helpers backing the `tree.*` IPC verbs that mutate the on-disk
 * Knowledge / Resources trees. (The Skills pane is read-only post-reframe
 * — agedum owns the source-of-truth — so `root === 'skills'` is rejected
 * here.) Each verb resolves the pane's on-disk root, joins the renderer-
 * supplied `dirRelPath` + child name, normalises, then re-checks the
 * result is still under the pane's root via `requirePathUnder` so a
 * renderer that hands us `..` / an absolute path can never escape the
 * bound. The renderer is trusted today, but we apply the same defence-
 * in-depth as `assertUnderConception` in `src/main/index.ts`.
 */

/** Resolve a tree root to its absolute on-disk path. Knowledge is hardcoded
 * to `<conception>/knowledge/`; resources is hardcoded to
 * `<conception>/resources/`. Skills are read-only and rejected here. */
async function resolveRoot(root: TreeRoot): Promise<string> {
  const { lastConceptionPath: conceptionPath } = await readSettings();
  if (!conceptionPath) throw new Error('no conception path is set');
  if (root === 'knowledge') return join(conceptionPath, 'knowledge');
  if (root === 'resources') return join(conceptionPath, DEFAULT_RESOURCES_PATH);
  if (root === 'skills') throw new Error('Skills tree is read-only');
  throw new Error(`unknown tree root: ${root as string}`);
}

/** Lowercase, replace runs of non-alphanumerics with `-`, trim leading/
 *  trailing hyphens. Empty input maps to a single placeholder. */
function sanitiseSegment(name: string, fallback: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Sanitise `filename`, splitting any user-supplied extension off so the
 *  basename is hyphen-cased without touching `.` characters. For
 *  knowledge the extension is always `.md`; for resources we keep
 *  the user's extension and default to `.md` when none was supplied. */
function buildFilename(root: TreeRoot, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error('filename must be a non-empty string');
  const ext = extname(trimmed).toLowerCase();
  const stem = ext ? trimmed.slice(0, trimmed.length - ext.length) : trimmed;
  const cleanedStem = sanitiseSegment(stem, 'untitled').replace(/\.+/g, '-');
  if (root === 'resources') {
    return cleanedStem + (ext || '.md');
  }
  // Knowledge: `.md` only.
  return cleanedStem + '.md';
}

/** Resolve `<root>/<dirRelPath>/<name>` and prove via realpath that it
 *  stays under the pane's root. Returns the canonical absolute path. */
async function resolveChildBounded(
  root: TreeRoot,
  dirRelPath: string,
  childName: string,
): Promise<{ rootAbs: string; targetAbs: string }> {
  const rootAbs = await resolveRoot(root);
  if (typeof dirRelPath !== 'string') {
    throw new Error('dirRelPath must be a string');
  }
  // `''` is allowed (means the root itself).
  const cleanedDir = normalize(dirRelPath);
  if (/^(\.\.([\\/]|$))/.test(cleanedDir) || cleanedDir.startsWith('/')) {
    throw new Error('dirRelPath escapes the pane root');
  }
  // After `normalize`, only literal `..` segments survive a traversal
  // attempt. A whole-string `.includes('..')` would also flag innocent
  // filenames like `foo..bar` mid-path, so split + segment-match.
  const segments = cleanedDir.split(/[\\/]/);
  if (segments.includes('..')) throw new Error('dirRelPath escapes the pane root');
  const dirAbs = cleanedDir === '' || cleanedDir === '.' ? rootAbs : join(rootAbs, cleanedDir);
  // The directory must already exist on disk and stay under the root.
  await requirePathUnder(dirAbs, rootAbs);
  const targetAbs = join(dirAbs, childName);
  // Sanity check that childName itself doesn't contain a separator that
  // would let the join slip out of the directory; sanitiseSegment already
  // strips them, but double-check before any writes.
  if (basename(targetAbs) !== childName) {
    throw new Error('invalid child name');
  }
  return { rootAbs, targetAbs };
}

/** Throw if `path` exists on disk and is a symbolic link. Used before any
 * filesystem op that would follow a symlink at the final target (mkdir,
 * non-`wx` write, copyFile without `COPYFILE_EXCL`). `wx` and
 * `COPYFILE_EXCL` already refuse a pre-existing target; this guard
 * exists for the operations that don't. ENOENT (target doesn't exist
 * yet) is fine — that's the legitimate create path. */
async function rejectSymlinkTarget(path: string): Promise<void> {
  let st;
  try {
    st = await fs.lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to follow symlink at ${basename(path)}`);
  }
}

export async function treeCreateMd(
  root: TreeRoot,
  dirRelPath: string,
  filename: string,
): Promise<string> {
  const sanitised = buildFilename(root, filename);
  const { targetAbs } = await resolveChildBounded(root, dirRelPath, sanitised);
  // `wx` flag refuses to overwrite — surfaces a clear error to the
  // renderer when the user picks a name that's already taken. Covered by
  // the create-path exemption to the tmp→rename invariant (internals.md
  // §2): the file is brand-new (and empty), so there's nothing to corrupt.
  await fs.writeFile(targetAbs, '', { encoding: 'utf8', flag: 'wx' });
  return toPosix(targetAbs);
}

export async function treeMkdir(root: TreeRoot, dirRelPath: string, name: string): Promise<string> {
  const sanitised = sanitiseSegment(name, '').replace(/\.+/g, '-');
  if (sanitised.length === 0) throw new Error('directory name is empty after sanitisation');
  const { targetAbs } = await resolveChildBounded(root, dirRelPath, sanitised);
  // `mkdir({recursive:true})` follows a symlink at `targetAbs` and creates
  // through it — reject if the entry exists as a symlink before we touch it.
  await rejectSymlinkTarget(targetAbs);
  await fs.mkdir(targetAbs, { recursive: true });
  return toPosix(targetAbs);
}

export async function treeImportFile(root: TreeRoot, dirRelPath: string): Promise<string | null> {
  // Resolve + bounds-check the destination before opening the dialog so
  // we never copy a file just to throw away on a bad target.
  const rootAbs = await resolveRoot(root);
  const cleanedDir = normalize(dirRelPath ?? '');
  const dirAbs = cleanedDir === '' || cleanedDir === '.' ? rootAbs : join(rootAbs, cleanedDir);
  await requirePathUnder(dirAbs, rootAbs);

  const result = await dialog.showOpenDialog({
    title: 'Import file',
    properties: ['openFile'],
    buttonLabel: 'Import',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const sourceAbs = result.filePaths[0];
  if (!sourceAbs) return null;
  const sourceName = basename(sourceAbs);
  // Sanitise just the basename — keep the extension verbatim so a `.pdf`
  // import lands as `.pdf`. For knowledge we still want `.md`-ish
  // material, but enforcing here would block the legitimate "drop a
  // PDF reference into knowledge/external/" workflow; leave the
  // categorisation to the user.
  const ext = extname(sourceName);
  const stem = ext ? sourceName.slice(0, sourceName.length - ext.length) : sourceName;
  const cleanedStem = sanitiseSegment(stem, 'imported').replace(/\.+/g, '-');
  const finalName = cleanedStem + ext;
  const targetAbs = join(dirAbs, finalName);
  if (basename(targetAbs) !== finalName) throw new Error('invalid imported filename');
  // `COPYFILE_EXCL` refuses to overwrite — same behaviour as createMd.
  await fs.copyFile(sourceAbs, targetAbs, fsConstants.COPYFILE_EXCL);
  return toPosix(targetAbs);
}
