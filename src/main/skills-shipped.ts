import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { SkillShippedInfo } from '../shared/types';

/**
 * Schema of `<skills_path>/.condash-skills.json`. Written by the condash
 * `skills install` command and read here so the Skills pane can flag
 * shipped files (and their local divergence from the shipped version).
 *
 * Only the fields we need are typed — the manifest may carry extra keys
 * for future use without breaking us.
 */
interface ShippedManifest {
  version?: number;
  skills?: Record<
    string,
    {
      files?: Record<
        string,
        {
          sha256?: string;
          shippedVersion?: string;
        }
      >;
    }
  >;
}

export interface ShippedLookup {
  /** Compute the shipped stamp for a `.md` file inside `skillsRoot`, or
   * return `null` when the file isn't tracked by the manifest. */
  lookup: (absPath: string, relPath: string) => Promise<SkillShippedInfo | null>;
}

/**
 * Build a one-shot lookup for a single tree read. The manifest is loaded
 * once and the lookup walks the in-memory map; on-disk SHA is computed
 * lazily per file so we only hash files the renderer actually surfaces.
 *
 * When `<skillsRoot>/.condash-skills.json` is missing or malformed, every
 * lookup returns `null` so the feature degrades silently.
 */
export async function buildShippedLookup(skillsRoot: string): Promise<ShippedLookup> {
  const manifestPath = join(skillsRoot, '.condash-skills.json');
  let manifest: ShippedManifest | null = null;
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      manifest = parsed as ShippedManifest;
    }
  } catch {
    /* No manifest, or unreadable / malformed — feature degrades silently. */
  }

  if (!manifest?.skills) {
    return { lookup: async () => null };
  }
  const skills = manifest.skills;

  return {
    lookup: async (absPath, relPath) => {
      // The manifest keys skills by their top-level directory and files by
      // their path *relative to that skill directory*. relPath is from the
      // skills root, so split off the first segment.
      const slash = relPath.indexOf('/');
      if (slash <= 0) return null;
      const skillName = relPath.slice(0, slash);
      const fileRel = relPath.slice(slash + 1);
      const fileEntry = skills[skillName]?.files?.[fileRel];
      if (!fileEntry?.sha256) return null;

      const diskSha = await sha256OfFile(absPath);
      if (diskSha === null) return null;

      return {
        manifestSha: fileEntry.sha256,
        diskSha,
        diverged: diskSha !== fileEntry.sha256,
        shippedVersion: fileEntry.shippedVersion,
      };
    },
  };
}

async function sha256OfFile(path: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}
