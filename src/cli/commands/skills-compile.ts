/**
 * Compile-and-emit pipeline for `condash skills install`: walks the skillspec
 * sources on disk (or the shipped tree on `--dry-run`), runs them through
 * `parseSkillspec` + `compileSkillspec` for each target, writes the per-target
 * output trees, and emits the compiled-side manifest (`.condash-skills.json`
 * under each target dir).
 *
 * The compile pass is decoupled from the install pass on purpose: the source
 * that gets compiled is whatever is on disk, so a user-edited (and therefore
 * refused) source still propagates to the compiled trees on the next install.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  COMPILE_TARGETS,
  compileSkillspec,
  parseSkillspec,
  SkillspecError,
  type CompileTarget,
} from '../../skillspec';
import { MANIFEST_RELPATH, MANIFEST_VERSION, sha256, writeFileMkdir } from './install-shared';
import { TARGET_RELPATHS, type ShippedSkill } from './skills-shipped';

export interface CompileAllOptions {
  /** Conception root (compiled outputs land under `<dest>/<TARGET_RELPATHS[t]>/`). */
  dest: string;
  /** `<dest>/.agents/skills` — where the skillspec sources live on disk. */
  sourceRoot: string;
  /** Currently-shipped skills (used to resolve dry-run compile sources). */
  shipped: ShippedSkill[];
  /** Stamped onto every compiled-side manifest entry. */
  shippedVersion: string;
  /** When true, parse/compile without writing anything (compile-from-shipped). */
  dryRun: boolean;
}

export interface CompileAllResult {
  /** One row per emitted (skill, target, file) — pushed into the install report. */
  compiled: { skill: string; target: CompileTarget; relPath: string }[];
}

/**
 * Compile every skillspec on disk to per-target outputs and write the
 * compiled-side manifests. Malformed specs are skipped silently — refusal is
 * surfaced by the install pass, not by crashing compile.
 */
export async function compileAllSkillspecs(opts: CompileAllOptions): Promise<CompileAllResult> {
  const { dest, sourceRoot, shipped, shippedVersion, dryRun } = opts;
  const skillNames = await collectInstalledSkillNames(sourceRoot, shipped);

  type CompiledManifest = Record<
    string,
    { files: Record<string, { sha256: string; shippedVersion: string }> }
  >;
  const compiledManifests: Record<CompileTarget, CompiledManifest> = {
    claude: {},
    kimi: {},
    opencode: {},
  };
  const compiled: CompileAllResult['compiled'] = [];

  for (const skillName of skillNames) {
    const skill = shipped.find((s) => s.name === skillName);
    const compileFromDir = dryRun && skill ? skill.sourceDir : join(sourceRoot, skillName);
    let parsed;
    try {
      parsed = await parseSkillspec(compileFromDir);
    } catch (err) {
      if (err instanceof SkillspecError) continue;
      throw err;
    }
    for (const target of COMPILE_TARGETS) {
      const result = compileSkillspec(parsed, target);
      const outputRoot = join(dest, TARGET_RELPATHS[target], skillName);
      if (!dryRun) await rmTreeIfPresent(outputRoot);
      compiledManifests[target][skillName] = { files: {} };
      for (const [relPath, content] of Object.entries(result.files)) {
        if (!dryRun) await writeFileMkdir(join(outputRoot, relPath), content);
        compiled.push({ skill: skillName, target, relPath });
        compiledManifests[target][skillName].files[relPath] = {
          sha256: sha256(content),
          shippedVersion,
        };
      }
    }
  }

  for (const target of COMPILE_TARGETS) {
    const manifest = { version: MANIFEST_VERSION, skills: compiledManifests[target] };
    const manifestPath = join(dest, TARGET_RELPATHS[target], MANIFEST_RELPATH);
    if (!dryRun) {
      await writeFileMkdir(
        manifestPath,
        Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
      );
    }
  }

  return { compiled };
}

/**
 * The list of skills to compile: every skill that has an
 * `.agents/skills/<name>/spec.yaml` on disk after the install pass, plus any
 * currently-shipped skill (caught in the dry-run case where the install pass
 * didn't write to disk). De-duplicated.
 */
export async function collectInstalledSkillNames(
  sourceRoot: string,
  shipped: ShippedSkill[],
): Promise<string[]> {
  const names = new Set<string>();
  for (const s of shipped) names.add(s.name);
  try {
    const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const spec = join(sourceRoot, entry.name, 'spec.yaml');
      try {
        await fs.access(spec);
        names.add(entry.name);
      } catch {
        /* not a skillspec dir — skip */
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return [...names].sort();
}

export async function rmTreeIfPresent(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
