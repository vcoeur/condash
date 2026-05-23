/**
 * Foundation module for `condash skills`: read the shipped skillspec tree
 * (the source-of-truth for repo-scope installs), and resolve the install
 * destination.
 *
 * Used by every repo-scope verb (`list`, `install`, `status`, `validate`).
 * User-scope verbs use `skills-user-fs.ts` instead.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { CliError, ExitCodes } from '../output';
import { resolveConception } from '../conception';
import { isIgnoredSourceArtifact } from '../../shared/source-artifacts';
import type { CompileTarget } from '../../skillspec';

/** Path of the skillspec source tree relative to the conception root. */
export const SOURCE_RELPATH = '.agents/skills';

/** Path of compiled outputs relative to the conception root, per target. */
export const TARGET_RELPATHS: Record<CompileTarget, string> = {
  claude: '.claude/skills',
  kimi: '.kimi/skills',
  opencode: '.opencode/skills',
};

export const KNOWN_FLAGS_LIST = ['dest', 'user'] as const;
export const KNOWN_FLAGS_INSTALL = ['dest', 'user', 'force', 'diff', 'dry-run', 'prune'] as const;
export const KNOWN_FLAGS_STATUS = ['dest', 'user'] as const;
export const KNOWN_FLAGS_VALIDATE = ['dest', 'user'] as const;

export const NOUN_FLAGS: readonly string[] = [
  ...new Set<string>([
    ...KNOWN_FLAGS_LIST,
    ...KNOWN_FLAGS_INSTALL,
    ...KNOWN_FLAGS_STATUS,
    ...KNOWN_FLAGS_VALIDATE,
  ]),
];

export interface ShippedSkill {
  name: string;
  /** Absolute source dir under conception-template/.agents/skills/<name>/. */
  sourceDir: string;
  /** Source files relative to sourceDir, recursively (excluding hidden). */
  files: string[];
  /** Description from spec.yaml, if parseable. */
  description: string | null;
}

export async function resolveDest(args: { flags: Record<string, unknown> }): Promise<string> {
  const explicit = args.flags.dest;
  if (typeof explicit === 'string') {
    return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  }
  try {
    const resolved = await resolveConception(undefined);
    return resolved.path;
  } catch {
    return process.cwd();
  }
}

export async function readShippedSkills(): Promise<ShippedSkill[]> {
  const root = locateShippedSkillsRoot();
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    throw new CliError(
      ExitCodes.RUNTIME,
      `Could not read shipped skillspecs at ${root}: ${(err as Error).message}`,
    );
  }
  const out: ShippedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sourceDir = join(root, entry.name);
    const files = await collectFilesRelative(sourceDir);
    const description = await extractDescriptionFromSpec(join(sourceDir, 'spec.yaml')).catch(
      () => null,
    );
    out.push({ name: entry.name, sourceDir, files, description });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function locateShippedSkillsRoot(): string {
  const override = process.env.CONDASH_TEMPLATE_ROOT;
  if (override) return join(override, SOURCE_RELPATH);
  return join(__dirname, '..', 'conception-template', SOURCE_RELPATH);
}

export async function collectFilesRelative(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (isIgnoredSourceArtifact(entry.name)) continue;
      const next = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next, rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await walk(dir, '');
  out.sort();
  return out;
}

export async function extractDescriptionFromSpec(specPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(specPath, 'utf8');
    const match = raw.match(/^description:\s*(.+?)\s*$/m);
    if (!match) return null;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 110) value = value.slice(0, 109) + '…';
    return value;
  } catch {
    return null;
  }
}
