/**
 * Top-level shipped-file install for `condash skills install`.
 *
 * Each entry in `SHIPPED_FILES` lives at the conception root and ships the
 * body of one heading-delimited region. Two entries today:
 *   - `AGENTS.md` — `## General` (markdown H2). Renamed from `CLAUDE.md`
 *     in v2.29.0; an existing `CLAUDE.md` (without an `AGENTS.md` sibling)
 *     is auto-renamed on first install so legacy installs migrate cleanly.
 *   - `.gitignore` — `# General` (gitignore-comment style; sibling
 *     `# Specifics` terminates the region).
 * The surrounding text — anything before the General heading and the
 * user-owned `Specifics` section that follows — is never touched. Hash-based
 * safe-update model matching the agent-skill source files:
 *
 *   - region matches manifest → unchanged → safe to push the new shipped region.
 *   - region differs from manifest → user edited → refuse without --force.
 *   - region present but file not in manifest → orphan → treat as edited.
 *   - heading absent or ambiguous → no region to write through; refuse without
 *     --force. With --force, write the entire shipped file (everything before
 *     `General` + `General` body + placeholder `Specifics` section).
 *   - file absent entirely → fresh install path → write the shipped file.
 *   - shipped bundle no longer ships the file (a previous condash version
 *     installed it; the current one dropped it) → source-missing. Skipped
 *     in install with a warning; `--prune` clears the manifest entry.
 *
 * Manifest entries written by older condash versions used the `templates`
 * namespace; the v2 → v3 manifest migration renames it to `files`. Region
 * keys recorded as `"condash:general"` (the HTML-comment-marker namespace
 * used before v2.29.0) are translated to `"General"` on the next install.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_MD_TARGETS, compileAgentsMd, type AgentsMdTarget } from '../../agents-md';
import { CliError, ExitCodes } from '../output';
import {
  cheapDiff,
  sha256,
  writeFileMkdir,
  type Manifest,
  type ManifestRegionEntry,
} from './install-shared';
import { DEFAULT_MARK, extractRegion, replaceRegion, type HeadingOpts } from './regions';

/** Compiled-output path per target, relative to the conception root. */
const AGENTS_MD_OUTPUTS: Record<AgentsMdTarget, string> = {
  claude: '.claude/CLAUDE.md',
  kimi: '.kimi/AGENTS.md',
};

export interface ShippedFile {
  /** Path relative to dest root, e.g. "AGENTS.md". */
  path: string;
  /** Heading text for the shipped region, e.g. "General" — matches `## General`. */
  region: string;
  /**
   * Heading prefix without trailing whitespace. Default '##' (markdown H2 —
   * used by AGENTS.md). For gitignore-style files use '#'.
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
 * Hardcoded list of top-level files condash ships partially. Adding more is
 * a one-line append plus a new entry in `conception-template/`.
 */
export const SHIPPED_FILES: ShippedFile[] = [
  { path: 'AGENTS.md', region: 'General' },
  { path: '.gitignore', region: 'General', mark: '#', siblings: ['Specifics'] },
];

export function optsFor(t: ShippedFile): HeadingOpts {
  return { mark: t.mark ?? DEFAULT_MARK, siblings: t.siblings };
}

export function locateShippedFilesRoot(): string {
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
export function migrateLegacyRegion(region: string): string {
  if (region === 'condash:general') return 'General';
  return region;
}

/**
 * Migrate a legacy `<dest>/CLAUDE.md` to `<dest>/AGENTS.md` when the new
 * filename doesn't yet exist. Returns true if a rename happened so the
 * caller can also migrate the manifest entry.
 */
export async function maybeRenameClaudeMdToAgentsMd(dest: string): Promise<boolean> {
  const oldPath = join(dest, 'CLAUDE.md');
  const newPath = join(dest, 'AGENTS.md');
  let oldExists = false;
  let newExists = false;
  try {
    await fs.access(oldPath);
    oldExists = true;
  } catch {
    /* not present */
  }
  try {
    await fs.access(newPath);
    newExists = true;
  } catch {
    /* not present */
  }
  if (oldExists && !newExists) {
    await fs.rename(oldPath, newPath);
    return true;
  }
  return false;
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
  const sourceFullPath = join(locateShippedFilesRoot(), file.path);

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

/**
 * Compile AGENTS.md → per-target output files (`.claude/CLAUDE.md` +
 * `.kimi/AGENTS.md`). Compiled outputs are deterministic from the source
 * and aren't tracked by the manifest — they're regenerated on every
 * install. Returns the empty array (and writes nothing) if AGENTS.md
 * doesn't exist on disk.
 */
export async function compileAgentsMdToTargets(
  dest: string,
  dryRun: boolean,
): Promise<{ target: AgentsMdTarget; path: string }[]> {
  const agentsMdPath = join(dest, 'AGENTS.md');
  let source: string | null = null;
  try {
    source = await fs.readFile(agentsMdPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (source === null) return [];
  const written: { target: AgentsMdTarget; path: string }[] = [];
  for (const target of AGENTS_MD_TARGETS) {
    const compiled = compileAgentsMd(source, target);
    const outputPath = join(dest, AGENTS_MD_OUTPUTS[target]);
    if (!dryRun) await writeFileMkdir(outputPath, Buffer.from(compiled, 'utf8'));
    written.push({ target, path: AGENTS_MD_OUTPUTS[target] });
  }
  return written;
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
    return {
      path: file.path,
      region: file.region,
      state: 'missing-heading',
      shippedVersion: entry?.shippedVersion ?? null,
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
  const sourcePath = join(locateShippedFilesRoot(), file.path);
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
  const shippedSet = new Set(SHIPPED_FILES.map((f) => f.path));
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
  const shippedSet = new Set(SHIPPED_FILES.map((f) => f.path));
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

/**
 * Pick the manifest entries that belong to a file path. Internal helper —
 * not currently used outside this module, but exported because skills.ts
 * may want to migrate legacy CLAUDE.md → AGENTS.md manifest entries when
 * triggered by `maybeRenameClaudeMdToAgentsMd`.
 */
export function migrateClaudeMdManifestEntry(manifest: Manifest): void {
  if (!manifest.files) return;
  const claude = manifest.files['CLAUDE.md'];
  if (!claude) return;
  if (manifest.files['AGENTS.md']) return;
  manifest.files['AGENTS.md'] = claude;
  delete manifest.files['CLAUDE.md'];
}

// Re-export the manifest entry type so callers don't have to import from
// two places when they're already dealing with files.ts.
export type { ManifestRegionEntry };
