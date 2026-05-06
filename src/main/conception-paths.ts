import { promises as fs } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { DEFAULT_RESOURCES_PATH, DEFAULT_SKILLS_PATH } from './config-schema';

/**
 * Resolve `resources_path` and `skills_path` from a conception's
 * `configuration.json`, falling back to the schema defaults when the file
 * is missing, malformed, or doesn't carry the keys.
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
  const file = join(conceptionPath, 'configuration.json');
  let parsed: { resources_path?: unknown; skills_path?: unknown } = {};
  try {
    const raw = await fs.readFile(file, 'utf8');
    const json = JSON.parse(raw) as unknown;
    if (json && typeof json === 'object') {
      parsed = json as { resources_path?: unknown; skills_path?: unknown };
    }
  } catch {
    /* fall through with defaults */
  }
  return {
    resources: pickRelative(parsed.resources_path, DEFAULT_RESOURCES_PATH),
    skills: pickRelative(parsed.skills_path, DEFAULT_SKILLS_PATH),
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
