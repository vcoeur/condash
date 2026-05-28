import { DEFAULT_RESOURCES_PATH, DEFAULT_SKILLS_PATH } from './config-schema';

/**
 * Resolve the on-disk conception-relative paths for the Resources and
 * Skills panes. Post-reframe both are hard-coded constants — the
 * `resources_path` and `skills_path` config keys were dropped. The helper
 * remains so callers see one canonical shape; it's now synchronous and
 * needs no config read.
 */
export function resolveConceptionPaths(): { resources: string; skills: string } {
  return { resources: DEFAULT_RESOURCES_PATH, skills: DEFAULT_SKILLS_PATH };
}
