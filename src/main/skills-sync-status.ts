/**
 * Aggregate sync state of the condash-shipped skills for one conception —
 * backs the status-bar shipped-skills indicator.
 *
 * The per-file classification mirrors `condash skills status`
 * (`cli/commands/skills-status.ts`), but this is a compact aggregate for the
 * indicator (how many files need installing) rather than the full per-file
 * report, and it resolves the shipped source from the caller (the main process
 * passes `app.getAppPath()`-derived path) instead of the CLI's `__dirname`
 * lookup. It is a pure fs read: no manifest mutation, no install.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { SkillsSyncStatus } from '../shared/types';
import { isIgnoredSourceArtifact } from '../shared/source-artifacts';

/** Minimal slice of `.condash-skills.json` we read: per-file installed sha. */
interface ShippedManifest {
  skills?: Record<string, { source?: Record<string, { sha256?: string }> }>;
}

interface ShippedSkillDir {
  name: string;
  /** Absolute source directory of this shipped skill. */
  dir: string;
  /** Files relative to `dir`, recursively (hidden + ignored artifacts skipped). */
  files: string[];
}

/**
 * Compute the aggregate shipped-skills sync state for one conception.
 *
 * `shippedRoot` is the running condash's bundled skill source
 * (`<appPath>/conception-template/.agents/skills`); `dest` is the conception
 * root. For every shipped file the on-disk copy under `<dest>/.agents/skills`
 * is compared against the shipped bytes and the install manifest
 * (`<dest>/.agents/.condash-skills.json`):
 *
 *   - absent on disk                          → needs install (missing)
 *   - on disk === shipped                     → in sync
 *   - differs, but on disk === manifest sha   → needs install (outdated: condash
 *                                               shipped a newer version)
 *   - differs from both                       → edited (local change; informational)
 *
 * A missing shipped source, an unreadable dest, or a malformed manifest all
 * degrade to a not-installed / zeroed result rather than throwing.
 */
export async function getSkillsSyncStatus(
  shippedRoot: string,
  dest: string,
): Promise<SkillsSyncStatus> {
  const installedRoot = join(dest, '.agents', 'skills');
  const manifest = await readManifest(join(dest, '.agents', '.condash-skills.json'));
  const skills = await listShippedSkills(shippedRoot);

  let shippedTotal = 0;
  let needsInstall = 0;
  let edited = 0;
  let anyOnDisk = false;

  for (const skill of skills) {
    for (const rel of skill.files) {
      shippedTotal += 1;
      const [shippedSha, diskSha] = await Promise.all([
        sha256OfFile(join(skill.dir, rel)),
        sha256OfFile(join(installedRoot, skill.name, rel)),
      ]);
      if (diskSha === null) {
        needsInstall += 1; // missing
        continue;
      }
      anyOnDisk = true;
      if (shippedSha !== null && diskSha === shippedSha) continue; // unchanged
      const manifestSha = manifest?.skills?.[skill.name]?.source?.[rel]?.sha256 ?? null;
      if (manifestSha !== null && diskSha === manifestSha) {
        needsInstall += 1; // outdated: installed matches the manifest, shipped moved on
      } else {
        edited += 1; // locally modified (install would overwrite)
      }
    }
  }

  const installed = anyOnDisk || manifest !== null;
  return {
    installed,
    shippedTotal,
    needsInstall,
    edited,
    synced: installed && needsInstall === 0,
  };
}

async function listShippedSkills(root: string): Promise<ShippedSkillDir[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ShippedSkillDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    out.push({ name: entry.name, dir, files: await collectFilesRelative(dir) });
  }
  return out;
}

/** Recursive relative file list under `dir`, skipping hidden entries and the
 *  ignored source artifacts (`.DS_Store`, etc.) — matching what
 *  `condash skills install` lays down. */
async function collectFilesRelative(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || isIgnoredSourceArtifact(entry.name)) continue;
      const next = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next, rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await walk(dir, '');
  return out;
}

async function readManifest(path: string): Promise<ShippedManifest | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as ShippedManifest) : null;
  } catch {
    return null;
  }
}

async function sha256OfFile(path: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await fs.readFile(path))
      .digest('hex');
  } catch {
    return null;
  }
}
