/**
 * Shared helpers for `condash skills install`.
 *
 * Since v3 there is one CLI noun (`skills`) that covers two kinds of shipped
 * artefacts:
 *   - **Agent skills** under `<dest>/.agents/skills/<name>/` — full files,
 *     hash-tracked per relPath.
 *   - **Top-level files** at the conception root (e.g. AGENTS.md, .gitignore)
 *     — heading-delimited regions, hash-tracked per file by region body.
 *
 * The CLI writes one manifest on each install:
 *   - `<dest>/.agents/.condash-skills.json` — source refuse-on-edit. Tracks
 *     each shipped source file under `.agents/skills/`. Used by the
 *     skills walker to flag local edits before re-installing.
 *
 * condash no longer compiles SKILL.md into per-harness output dirs; the
 * harness launcher renders skills per agent at run time. `readManifest`
 * migrates a legacy `.claude/skills/.condash-skills.json` to the new
 * `.agents/` location on first read (one-shot, the legacy file is moved).
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError, ExitCodes } from '../output';

export const MANIFEST_RELPATH = '.condash-skills.json';
export const MANIFEST_VERSION = 3;

export interface ManifestFileEntry {
  /** SHA256 of the file content as we wrote it at last install. */
  sha256: string;
  /** condash version that shipped this content. */
  shippedVersion: string;
}

/**
 * Per-skill manifest entry.
 *
 * Tracks **source** files only — files under
 * `<dest>/.agents/skills/<name>/`. Source files use refuse-on-edit
 * semantics: if the on-disk SHA matches the manifest, condash overwrites
 * with the newly-shipped content; if it differs, condash refuses without
 * `--force`. condash no longer fan-installs into per-harness output dirs,
 * so the manifest only tracks `.agents/skills/`.
 */
export interface ManifestSkillEntry {
  source: Record<string, ManifestFileEntry>;
}

/**
 * Top-level file manifest entry (heading-delimited region).
 *
 * Tracks the hash of the **region body** — everything between the
 * `## <region>` heading line (exclusive) and the next sibling heading
 * (exclusive) or end-of-file. The surrounding file content is user-owned
 * and never touched.
 */
export interface ManifestRegionEntry {
  /** Heading text for the shipped region, e.g. "General" — matches `## General`.
   *  Older manifests may carry the legacy marker namespace (`"condash:general"`);
   *  the v1 → v2 migration moves it to `"General"` (the heading text). */
  region: string;
  /** SHA256 of the region body. */
  sha256: string;
  /** condash version that shipped this region. */
  shippedVersion: string;
}

export interface Manifest {
  version: number;
  skills: Record<string, ManifestSkillEntry>;
  /**
   * Optional — older manifests don't have it. Keyed by file path relative
   * to dest (e.g. `"AGENTS.md"`, `".gitignore"`).
   *
   * Renamed from `templates` in v3. The migration in `readManifest`
   * carries v2 `templates` entries forward as `files` unchanged.
   */
  files?: Record<string, ManifestRegionEntry>;
}

/** Read the source manifest at `<dest>/.agents/.condash-skills.json`.
 *
 * If the new location doesn't exist, falls back to the legacy path
 * `<dest>/.claude/skills/.condash-skills.json` and **moves** it to
 * `.agents/` transparently. This is a one-time migration.
 *
 * Migrates older schemas in-memory on read:
 *
 *   - **v1 → v3**: discards v1 `skills` entries (they tracked compiled-output
 *     hashes at a different location; v2+ tracks skillspec sources). v1
 *     `templates` entries carry forward to v3 `files` unchanged. The next
 *     install re-seeds the skills section from scratch.
 *   - **v2 → v3**: renames the `templates` namespace to `files`. Schema is
 *     otherwise identical, so entries copy over byte-for-byte.
 *
 * Migration is in-memory only; the manifest file is rewritten on the next
 * `writeManifest` call.
 */
export async function readManifest(dest: string): Promise<Manifest | null> {
  const newPath = join(dest, '.agents', MANIFEST_RELPATH);
  const legacyPath = join(dest, '.claude', 'skills', MANIFEST_RELPATH);
  type LegacyManifest = Manifest & { templates?: Record<string, ManifestRegionEntry> };

  let path = newPath;
  let raw: string;
  try {
    raw = await fs.readFile(newPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CliError(
        ExitCodes.RUNTIME,
        `Could not read manifest at ${newPath}: ${(err as Error).message}`,
      );
    }
    // Fall back to legacy path and migrate if present.
    try {
      raw = await fs.readFile(legacyPath, 'utf8');
      path = legacyPath;
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CliError(
        ExitCodes.RUNTIME,
        `Could not read manifest at ${legacyPath}: ${(err2 as Error).message}`,
      );
    }
  }

  let parsed: LegacyManifest;
  try {
    parsed = JSON.parse(raw) as LegacyManifest;
  } catch (err) {
    throw new CliError(
      ExitCodes.RUNTIME,
      `Could not parse manifest at ${path}: ${(err as Error).message}`,
    );
  }

  if (parsed.version === 1) {
    parsed = {
      version: MANIFEST_VERSION,
      skills: {},
      files: parsed.templates,
    };
  } else if (parsed.version === 2) {
    parsed = {
      version: MANIFEST_VERSION,
      skills: parsed.skills ?? {},
      files: parsed.templates,
    };
  } else if (parsed.version !== MANIFEST_VERSION) {
    throw new CliError(
      ExitCodes.RUNTIME,
      `Manifest at ${path} has unknown version ${parsed.version} (expected ${MANIFEST_VERSION})`,
    );
  }
  if (!parsed.skills) parsed.skills = {};

  // Coerce every per-skill entry to the canonical `{ source: {...} }` shape.
  // A v3 manifest written before the source/compiled-output split (the pre-v4
  // schema tracked compiled outputs under a `files` key) carries entries with
  // no `source` map under the same version number. Install, prune, and the
  // source-missing walk all index `entry.source`, so a stale entry would crash
  // with "Cannot set properties of undefined". Discard the stale keys and
  // re-seed empty — the next install repopulates from the shipped sources.
  for (const [name, entry] of Object.entries(parsed.skills)) {
    if (!entry || !entry.source) parsed.skills[name] = { source: {} };
  }

  // One-time transparent migration: legacy path → new path.
  if (path === legacyPath) {
    await fs.mkdir(dirname(newPath), { recursive: true });
    await fs.rename(legacyPath, newPath);
  }

  return parsed;
}

export async function writeManifest(dest: string, manifest: Manifest): Promise<void> {
  const path = join(dest, '.agents', MANIFEST_RELPATH);
  await writeFileMkdir(path, Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));
}

/**
 * Atomic file write: tmp → fsync → rename. The fsync is required so a
 * power-loss between writeFile and rename can't leave a zero-length file
 * poisoning the next install run. Same invariant as src/main/atomic-write.ts.
 */
export async function writeFileMkdir(path: string, content: Buffer): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${Date.now()}.${process.pid}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}

export function sha256(content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Cheap unified-style diff sufficient for human inspection. Real diff libs
 * (jsdiff) would balloon the bundle for marginal value here — `--diff` is
 * an inspection aid, not a merge tool.
 */
export function cheapDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const out: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) continue;
    if (a !== undefined) out.push(`- ${a}`);
    if (b !== undefined) out.push(`+ ${b}`);
  }
  return out.join('\n');
}
