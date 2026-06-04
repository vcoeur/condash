/**
 * Top-level shipped-file install for `condash skills install`.
 *
 * Two kinds of conception-root files are handled here:
 *
 *   - **Region-delimited files** (`SHIPPED_FILES`) — each ships the body of one
 *     heading-delimited region; the surrounding text is user-owned and never
 *     touched. `SHIPPED_FILES` is currently empty (condash no longer ships
 *     `.gitignore`); the machinery is kept for future files. Hash-based
 *     safe-update model matching the agent-skill source files:
 *
 *       - region matches manifest → unchanged → safe to push the new shipped region.
 *       - region differs from manifest → user edited → refuse without --force.
 *       - region present but file not in manifest → orphan → treat as edited.
 *       - heading absent or ambiguous → no region to write through; refuse without
 *         --force. With --force, write the entire shipped file.
 *       - file absent entirely → fresh install path → write the shipped file.
 *       - shipped bundle no longer ships the file → source-missing. Skipped
 *         in install with a warning; `--prune` clears the manifest entry.
 *
 *   - **The `AGENTS.md` marker region** (`installAgentsMd`) — condash owns
 *     everything from line 1 through the `<!-- end condash agents -->` marker
 *     (inclusive) and regenerates it on every install; everything after the
 *     marker is the conception's own content, preserved verbatim. Not
 *     manifest-tracked — the marker is the boundary, so there is no hash to
 *     reconcile.
 *
 * Manifest entries written by older condash versions used the `templates`
 * namespace; the v2 → v3 manifest migration renames it to `files`. Region
 * keys recorded as `"condash:general"` (the HTML-comment-marker namespace
 * used before v2.29.0) are translated to `"General"` on the next install.
 */

import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { CliError, ExitCodes } from '../output';
import {
  cheapDiff,
  sha256,
  writeFileMkdir,
  type Manifest,
  type ManifestRegionEntry,
} from './install-shared';
import { DEFAULT_MARK, extractRegion, replaceRegion, type HeadingOpts } from './regions';

export interface ShippedFile {
  /** Path relative to dest root, e.g. "AGENTS.md". */
  path: string;
  /**
   * Path of the source under `conception-template/`, if it differs from
   * `path`. Set when the on-disk destination name would otherwise be filtered
   * out of the packaged asar — electron-builder's default file filter drops
   * top-level `.gitignore` / `.gitattributes` before they ever reach the
   * archive. Defaults to `path` when omitted.
   */
  sourcePath?: string;
  /** Heading text for the shipped region, e.g. "General" — matches `## General`. */
  region: string;
  /**
   * Heading prefix without trailing whitespace. Default '##' (markdown H2).
   * For gitignore-style files use '#'.
   */
  mark?: string;
  /**
   * Fixed sibling section names that end this region's body. When set, the
   * "next heading" regex matches *only* these names — required for gitignore-
   * style files where every comment line shares the mark with section
   * headings.
   */
  siblings?: string[];
}

/**
 * Hardcoded list of top-level files condash ships partially. Currently empty:
 * condash ships only the agent-skill sources and the `AGENTS.md` marker
 * region. Adding one back is a one-line append here plus a new entry in
 * `conception-template/`. The region-merge machinery below is retained for
 * that, and to reconcile legacy manifest `files` entries (e.g. a `.gitignore`
 * shipped by condash ≤ 4.0.1) via the source-missing / `--prune` path.
 *
 * A file whose on-disk destination name would be filtered out of the packaged
 * asar (electron-builder drops bare dotfiles like `.gitignore`) ships under an
 * alias via `sourcePath`.
 */
export const SHIPPED_FILES: ShippedFile[] = [];

function optsFor(t: ShippedFile): HeadingOpts {
  return { mark: t.mark ?? DEFAULT_MARK, siblings: t.siblings };
}

/** Absolute path of the shipped source for a file (honours `sourcePath`). */
function sourceFor(file: ShippedFile): string {
  return join(locateShippedFilesRoot(), file.sourcePath ?? file.path);
}

function locateShippedFilesRoot(): string {
  // Same resolution as skills: override hatch primarily for tests, then walk
  // up from the bundled CLI to find conception-template/.
  const override = process.env.CONDASH_TEMPLATE_ROOT;
  if (override) return override;
  return join(__dirname, '..', 'conception-template');
}

/**
 * Older condash versions stored the HTML-comment-marker namespace
 * (`condash:general`) as the region key. Headings replaced markers; this
 * maps the legacy value to the new heading text so an existing install
 * reconciles without a forced overwrite.
 */
function migrateLegacyRegion(region: string): string {
  if (region === 'condash:general') return 'General';
  return region;
}

export type FileInstallState =
  | 'copied'
  | 'updated'
  | 'unchanged'
  | 'forced'
  | 'refused'
  | 'source-missing';

export interface FileInstallOutcome {
  path: string;
  region: string;
  state: FileInstallState;
  reason?: string;
  diff?: string;
}

export interface FileInstallParams {
  dest: string;
  shippedVersion: string;
  force: boolean;
  showDiff: boolean;
  dryRun: boolean;
  manifest: Manifest;
}

/**
 * Install one shipped file. Mutates `params.manifest.files` in place; the
 * caller is responsible for writing the manifest after all entries process.
 *
 * Source-missing: when the shipped file is gone from the bundle, returns
 * the `source-missing` outcome and leaves the manifest entry intact. The
 * caller's `--prune` pass clears stale entries.
 */
export async function installShippedFile(
  file: ShippedFile,
  params: FileInstallParams,
): Promise<FileInstallOutcome> {
  const { dest, shippedVersion, force, showDiff, dryRun, manifest } = params;
  if (!manifest.files) manifest.files = {};
  const files = manifest.files;
  const opts = optsFor(file);
  const sourceFullPath = sourceFor(file);

  let sourceContent: string;
  try {
    sourceContent = await fs.readFile(sourceFullPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: file.path, region: file.region, state: 'source-missing' };
    }
    throw err;
  }

  const sourceRegion = extractRegion(sourceContent, file.region, opts);
  if (sourceRegion === null) {
    throw new CliError(
      ExitCodes.RUNTIME,
      `Shipped file ${file.path} is missing markers for region ${file.region}`,
    );
  }
  const sourceRegionHash = sha256(sourceRegion);
  const targetPath = join(dest, file.path);

  let onDisk: string | null = null;
  try {
    onDisk = await fs.readFile(targetPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // File missing entirely → fresh install: write the whole shipped file
  // (heading + placeholder Specifics section).
  if (onDisk === null) {
    if (!dryRun) await writeFileMkdir(targetPath, Buffer.from(sourceContent, 'utf8'));
    files[file.path] = {
      region: file.region,
      sha256: sourceRegionHash,
      shippedVersion,
    };
    return { path: file.path, region: file.region, state: 'copied' };
  }

  const onDiskRegion = extractRegion(onDisk, file.region, opts);

  // Markers absent: there's no region to update through. Without --force,
  // refuse so the user knows the file isn't being touched. With --force,
  // overwrite the whole file (same content as fresh install).
  if (onDiskRegion === null) {
    const diff = showDiff ? cheapDiff(onDisk, sourceContent) : undefined;
    if (force) {
      if (!dryRun) await writeFileMkdir(targetPath, Buffer.from(sourceContent, 'utf8'));
      files[file.path] = {
        region: file.region,
        sha256: sourceRegionHash,
        shippedVersion,
      };
      return { path: file.path, region: file.region, state: 'forced', diff };
    }
    return {
      path: file.path,
      region: file.region,
      state: 'refused',
      reason: `heading "${opts.mark} ${file.region}" not found (or ambiguous)`,
      diff,
    };
  }

  const onDiskRegionHash = sha256(onDiskRegion);

  // Region matches shipped → already converged. Refresh manifest entry so
  // shippedVersion reflects today's run.
  if (onDiskRegionHash === sourceRegionHash) {
    files[file.path] = {
      region: file.region,
      sha256: sourceRegionHash,
      shippedVersion,
    };
    return { path: file.path, region: file.region, state: 'unchanged' };
  }

  const tracked = files[file.path];
  const trackedRegion = tracked ? migrateLegacyRegion(tracked.region) : null;
  if (tracked && trackedRegion === file.region && tracked.sha256 === onDiskRegionHash) {
    // Region matches manifest (user hasn't edited since last install) → safe
    // to push the new shipped region.
    if (!dryRun) {
      const updated = replaceRegion(onDisk, file.region, sourceRegion, opts);
      await writeFileMkdir(targetPath, Buffer.from(updated, 'utf8'));
    }
    files[file.path] = {
      region: file.region,
      sha256: sourceRegionHash,
      shippedVersion,
    };
    return { path: file.path, region: file.region, state: 'updated' };
  }

  // Edited (or untracked-but-present). Refuse without --force.
  const diff = showDiff ? cheapDiff(onDiskRegion, sourceRegion) : undefined;
  if (force) {
    if (!dryRun) {
      const updated = replaceRegion(onDisk, file.region, sourceRegion, opts);
      await writeFileMkdir(targetPath, Buffer.from(updated, 'utf8'));
    }
    files[file.path] = {
      region: file.region,
      sha256: sourceRegionHash,
      shippedVersion,
    };
    return { path: file.path, region: file.region, state: 'forced', diff };
  }
  return {
    path: file.path,
    region: file.region,
    state: 'refused',
    reason: tracked ? 'edited since last install' : 'present but not tracked by manifest',
    diff,
  };
}

// ---------------------------------------------------------------------------
// AGENTS.md marker region
// ---------------------------------------------------------------------------

/** Conception-root AGENTS.md, written by `installAgentsMd`. */
export const AGENTS_MD_PATH = 'AGENTS.md';
/** Source template under `conception-template/`. */
const AGENTS_MD_SOURCE = 'AGENTS.md';
/**
 * The boundary line. condash owns `[line 1 .. marker]` (inclusive) and
 * regenerates it on install; everything after the marker is user-owned and
 * preserved verbatim. An HTML comment so it's invisible in rendered markdown.
 */
export const AGENTS_MD_MARKER = '<!-- end condash agents -->';

export interface AgentsMdOutcome {
  path: string;
  /**
   * `created` — wrote a fresh file (head + shipped Specifics stub).
   * `updated` — regenerated the head, preserved the existing tail.
   * `migrated` — a marker-less file: prepended the head and pushed the whole
   *   existing file below the marker (non-destructive).
   * `unchanged` — head + tail already byte-identical to what we'd write.
   */
  state: 'created' | 'updated' | 'migrated' | 'unchanged';
}

const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function substituteVariables(content: string, variables: Record<string, string>): string {
  return content.replace(VARIABLE_RE, (_, name: string) => variables[name] ?? '');
}

/** Split a document at the first line equal to `AGENTS_MD_MARKER`. Returns the
 *  head (lines `[0 .. marker]`, joined, no trailing newline) and the tail
 *  (everything after the marker, joined, no leading newline added). `markerIdx`
 *  is -1 when the marker is absent. */
function splitAtMarker(content: string): { head: string; tail: string; markerIdx: number } {
  const lines = content.split('\n');
  const markerIdx = lines.findIndex((l) => l === AGENTS_MD_MARKER);
  if (markerIdx === -1) return { head: '', tail: content, markerIdx };
  const head = lines.slice(0, markerIdx + 1).join('\n');
  const tail = lines.slice(markerIdx + 1).join('\n');
  return { head, tail, markerIdx };
}

/**
 * Maintain the conception-root `AGENTS.md` marker region.
 *
 * The shipped `conception-template/AGENTS.md` carries the condash-owned head
 * (H1 preamble + `## General` body), the `<!-- end condash agents -->` marker,
 * and a placeholder `## Specifics` stub below it. On install:
 *
 *   - **Fresh** (no file): write the substituted head + the shipped stub.
 *   - **Marker present**: regenerate the head, keep everything after the
 *     on-disk marker verbatim.
 *   - **Marker absent** (legacy / hand-made): prepend the head and push the
 *     entire existing file below the marker — non-destructive.
 *
 * `{{ conception_name }}` / `{{ description }}` in the head are substituted
 * per-conception. Idempotent: an unchanged head + unchanged tail rewrites the
 * same bytes and reports `unchanged`.
 */
export async function installAgentsMd(dest: string, dryRun: boolean): Promise<AgentsMdOutcome> {
  const shipped = await fs.readFile(join(locateShippedFilesRoot(), AGENTS_MD_SOURCE), 'utf8');
  const shippedSplit = splitAtMarker(shipped);
  if (shippedSplit.markerIdx === -1) {
    throw new CliError(
      ExitCodes.RUNTIME,
      `Shipped ${AGENTS_MD_SOURCE} is missing the "${AGENTS_MD_MARKER}" marker`,
    );
  }
  const variables = {
    conception_name: basename(dest),
    description: await readConceptionDescription(dest),
  };
  const head = substituteVariables(shippedSplit.head, variables);
  const shippedStub = shippedSplit.tail.replace(/\s+$/, '');

  const targetPath = join(dest, AGENTS_MD_PATH);
  const onDisk = await readFileOrNull(targetPath);

  let newContent: string;
  let state: AgentsMdOutcome['state'];
  if (onDisk === null) {
    newContent = `${head}\n${shippedStub}\n`;
    state = 'created';
  } else {
    const onDiskSplit = splitAtMarker(onDisk);
    if (onDiskSplit.markerIdx === -1) {
      // Marker-less legacy file: push the whole thing below the marker.
      newContent = `${head}\n\n${onDisk.replace(/^\s+/, '').replace(/\s+$/, '')}\n`;
      state = 'migrated';
    } else {
      newContent = `${head}\n${onDiskSplit.tail.replace(/\s+$/, '')}\n`;
      state = onDisk === newContent ? 'unchanged' : 'updated';
    }
  }

  if (!dryRun && state !== 'unchanged') {
    await writeFileMkdir(targetPath, Buffer.from(newContent, 'utf8'));
  }
  return { path: AGENTS_MD_PATH, state };
}

/** Read a file, returning null on ENOENT (rethrows other errors). */
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Optional one-line conception description for the `{{ description }}` preamble
 * variable. Read tolerantly from the versioned `condash.json` (`.description`),
 * falling back to the legacy `configuration.json`. Empty string when unset or
 * unparseable — the placeholder then resolves to a blank tagline.
 */
async function readConceptionDescription(dest: string): Promise<string> {
  for (const name of ['condash.json', 'configuration.json']) {
    const raw = await readFileOrNull(join(dest, name));
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as { description?: unknown };
      if (typeof parsed.description === 'string') return parsed.description;
    } catch {
      // Malformed config — ignore, try the next candidate.
    }
  }
  return '';
}

export type FileStatusState =
  | 'unchanged'
  | 'edited'
  | 'missing'
  | 'missing-heading'
  | 'orphan'
  | 'outdated'
  | 'source-missing';

export interface FileStatusRow {
  path: string;
  region: string;
  state: FileStatusState;
  shippedVersion: string | null;
}

/**
 * Status for a single shipped file. Returns null when the file isn't
 * installed and has no manifest entry (nothing to report).
 */
export async function statusShippedFile(
  file: ShippedFile,
  dest: string,
  manifest: Manifest,
): Promise<FileStatusRow | null> {
  const opts = optsFor(file);
  const files = manifest.files ?? {};
  const entry = files[file.path];
  const targetPath = join(dest, file.path);
  let onDisk: string | null = null;
  try {
    onDisk = await fs.readFile(targetPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (onDisk === null) {
    if (entry) {
      return {
        path: file.path,
        region: file.region,
        state: 'missing',
        shippedVersion: entry.shippedVersion,
      };
    }
    return null;
  }
  const onDiskRegion = extractRegion(onDisk, file.region, opts);
  if (onDiskRegion === null) {
    // No condash-owned region on disk. Only surface this when the manifest
    // already tracks the file (so the user previously opted in) — otherwise
    // the file is entirely user-owned and condash should stay silent.
    if (!entry) return null;
    return {
      path: file.path,
      region: file.region,
      state: 'missing-heading',
      shippedVersion: entry.shippedVersion,
    };
  }
  const onDiskHash = sha256(onDiskRegion);
  if (!entry) {
    return {
      path: file.path,
      region: file.region,
      state: 'orphan',
      shippedVersion: null,
    };
  }
  if (onDiskHash !== entry.sha256) {
    return {
      path: file.path,
      region: file.region,
      state: 'edited',
      shippedVersion: entry.shippedVersion,
    };
  }
  // On disk matches manifest. Compare to currently-shipped to detect updates.
  const sourcePath = sourceFor(file);
  let sourceRegion: string | null = null;
  try {
    const sourceContent = await fs.readFile(sourcePath, 'utf8');
    sourceRegion = extractRegion(sourceContent, file.region, opts);
  } catch {
    /* shipped source disappeared — falls through to source-missing below */
  }
  if (sourceRegion === null) {
    return {
      path: file.path,
      region: file.region,
      state: 'source-missing',
      shippedVersion: entry.shippedVersion,
    };
  }
  if (sha256(sourceRegion) !== entry.sha256) {
    return {
      path: file.path,
      region: file.region,
      state: 'outdated',
      shippedVersion: entry.shippedVersion,
    };
  }
  return {
    path: file.path,
    region: file.region,
    state: 'unchanged',
    shippedVersion: entry.shippedVersion,
  };
}

/**
 * Rows for manifest entries whose shipped source no longer exists in the
 * bundle. Surfaces the residue of `condash` versions that dropped a
 * top-level file.
 */
export function sourceMissingFileRows(manifest: Manifest): FileStatusRow[] {
  const shippedSet = knownShippedFilePaths();
  const rows: FileStatusRow[] = [];
  for (const [path, entry] of Object.entries(manifest.files ?? {})) {
    if (shippedSet.has(path)) continue;
    rows.push({
      path,
      region: migrateLegacyRegion(entry.region),
      state: 'source-missing',
      shippedVersion: entry.shippedVersion,
    });
  }
  return rows;
}

/**
 * Every file path condash knows how to (re)install. Used by status / prune
 * helpers so a tracked entry isn't mistaken for a stale source.
 */
function knownShippedFilePaths(): Set<string> {
  return new Set(SHIPPED_FILES.map((f) => f.path));
}

export interface FileListRow {
  path: string;
  region: string;
  installed: boolean;
  shippedVersion: string | null;
}

export function listShippedFiles(manifest: Manifest | null): FileListRow[] {
  return SHIPPED_FILES.map((f) => {
    const entry = manifest?.files?.[f.path];
    return {
      path: f.path,
      region: f.region,
      installed: !!entry,
      shippedVersion: entry?.shippedVersion ?? null,
    };
  });
}

/**
 * Drop manifest entries whose shipped source is gone from the bundle. Used
 * by `condash skills install --prune`. Returns the dropped entries so the
 * caller can report them.
 */
export function pruneSourceMissingFileEntries(manifest: Manifest): {
  path: string;
  region: string;
  shippedVersion: string;
}[] {
  if (!manifest.files) return [];
  const shippedSet = knownShippedFilePaths();
  const dropped: { path: string; region: string; shippedVersion: string }[] = [];
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (shippedSet.has(path)) continue;
    dropped.push({
      path,
      region: migrateLegacyRegion(entry.region),
      shippedVersion: entry.shippedVersion,
    });
    delete manifest.files[path];
  }
  return dropped;
}

// Re-export the manifest entry type so callers don't have to import from
// two places when they're already dealing with files.ts.
export type { ManifestRegionEntry };
