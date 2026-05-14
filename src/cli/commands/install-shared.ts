/**
 * Shared helpers for `condash skills install` and `condash templates install`.
 *
 * Both commands write to the same manifest at
 * `<dest>/.claude/skills/.condash-skills.json` (the `templates` namespace
 * lives alongside `skills` in the same file — one source of truth, one
 * version field). The file lives under `.claude/skills/` for historical
 * reasons; templates are top-level files but reusing the path avoids two
 * manifests that can drift.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError, ExitCodes } from '../output';

export const MANIFEST_RELPATH = '.condash-skills.json';
export const MANIFEST_VERSION = 2;

export interface ManifestFileEntry {
  /** SHA256 of the file content as we wrote it at last install. */
  sha256: string;
  /** condash version that shipped this content. */
  shippedVersion: string;
}

/**
 * Per-skill manifest entry, v2.
 *
 * Tracks **source** files only — files under `<dest>/<skills_source>/<name>/`
 * (default `<dest>/.agents/skills/<name>/`). Source files use refuse-on-edit
 * semantics: if the on-disk SHA matches the manifest, condash overwrites with
 * the newly-shipped content; if it differs, condash refuses without `--force`.
 *
 * Compiled outputs under `<dest>/.claude/skills/<name>/` and
 * `<dest>/.kimi/skills/<name>/` are deterministically regenerated from
 * sources on every install and are **not** tracked by the manifest. Users
 * are not expected to edit compiled outputs (a `<!-- GENERATED -->` banner
 * makes that explicit in each compiled `SKILL.md`).
 */
export interface ManifestSkillEntry {
  source: Record<string, ManifestFileEntry>;
}

export interface ManifestTemplateEntry {
  /** Heading text for the shipped region, e.g. "General" — matches `## General`.
   *  Older manifests may carry the legacy marker namespace (`"condash:general"`);
   *  the templates installer migrates that to `"General"` on the next install. */
  region: string;
  /** SHA256 of the region body (the H2 section's body, exclusive of the heading
   *  line and any trailing blank line before the next H2). */
  sha256: string;
  /** condash version that shipped this region. */
  shippedVersion: string;
}

export interface Manifest {
  version: number;
  skills: Record<string, ManifestSkillEntry>;
  /** Optional — older manifests don't have it. Keyed by file path relative to dest. */
  templates?: Record<string, ManifestTemplateEntry>;
}

/** Read the manifest at `<dest>/.claude/skills/.condash-skills.json`.
 *
 * Migrates v1 → v2 in-memory on read. The v1 schema tracked compiled-output
 * file SHAs (in the same directory the manifest lived under); v2 tracks
 * skillspec **source** file SHAs at a different location. The two have no
 * useful overlap, so v1 `skills` entries are discarded on migration —
 * the next v2 install re-seeds the manifest from scratch. v1 `templates`
 * entries carry forward unchanged.
 */
export async function readManifest(dest: string): Promise<Manifest | null> {
  const path = join(dest, '.claude', 'skills', MANIFEST_RELPATH);
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed.version === 1) {
      return {
        version: MANIFEST_VERSION,
        skills: {},
        templates: parsed.templates,
      };
    }
    if (parsed.version !== MANIFEST_VERSION) {
      throw new CliError(
        ExitCodes.RUNTIME,
        `Manifest at ${path} has unknown version ${parsed.version} (expected ${MANIFEST_VERSION})`,
      );
    }
    if (!parsed.skills) parsed.skills = {};
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof CliError) throw err;
    throw new CliError(
      ExitCodes.RUNTIME,
      `Could not read manifest at ${path}: ${(err as Error).message}`,
    );
  }
}

export async function writeManifest(dest: string, manifest: Manifest): Promise<void> {
  const path = join(dest, '.claude', 'skills', MANIFEST_RELPATH);
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
