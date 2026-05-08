import { isAbsolute, normalize } from 'node:path';
import { DEFAULT_RESOURCES_PATH, DEFAULT_SKILLS_PATH } from './config-schema';
import { getEffectiveConceptionConfig } from './effective-config';

/**
 * Resolve `resources_path` and `skills_path` from the effective config
 * (global `settings.json` ⊕ conception `condash.json` / legacy
 * `configuration.json`), falling back to the schema defaults when no file
 * supplies the keys.
 *
 * Each tree reader needs only the two relative paths, so this helper
 * stays narrow rather than re-deriving the full config shape — which
 * keeps the readers free of any direct config-file knowledge.
 *
 * Path-traversal guard: a `..` segment or absolute-path value would let
 * the watcher and the readers escape the conception tree, so anything
 * that doesn't normalise to a clean relative path falls back to the
 * default.
 */
export async function resolveConceptionPaths(conceptionPath: string): Promise<{
  resources: string;
  skills: string;
}> {
  const config = await getEffectiveConceptionConfig(conceptionPath);
  return {
    resources: pickRelative(config.resources_path, DEFAULT_RESOURCES_PATH),
    skills: pickRelative(config.skills_path, DEFAULT_SKILLS_PATH),
  };
}

function pickRelative(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  // Trim before the length check — a whitespace-only value was previously
  // accepted and got join()ed into an unexpected (whitespace-named) directory.
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  if (isAbsolute(trimmed)) return fallback;
  // path.normalize collapses `./foo/../bar` to `bar`; a leading `..` after
  // normalisation means the value escapes the conception root. Single
  // regex replaces the previous dual `'../'` / `'..\\'` startsWith checks
  // so future Windows path-shape quirks don't slip through.
  const normalised = normalize(trimmed);
  if (/^\.\.([\\/]|$)/.test(normalised)) return fallback;
  return normalised;
}
