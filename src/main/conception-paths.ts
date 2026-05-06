import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_RESOURCES_PATH, DEFAULT_SKILLS_PATH } from './config-schema';

/**
 * Resolve `resources_path` and `skills_path` from a conception's
 * `configuration.json`, falling back to the schema defaults when the file
 * is missing, malformed, or doesn't carry the keys.
 *
 * Each tree reader needs only the two relative paths, so this helper
 * stays narrow rather than re-deriving the full config shape — which
 * keeps the readers free of any direct config-file knowledge.
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
  const resources =
    typeof parsed.resources_path === 'string' && parsed.resources_path.length > 0
      ? parsed.resources_path
      : DEFAULT_RESOURCES_PATH;
  const skills =
    typeof parsed.skills_path === 'string' && parsed.skills_path.length > 0
      ? parsed.skills_path
      : DEFAULT_SKILLS_PATH;
  return { resources, skills };
}
