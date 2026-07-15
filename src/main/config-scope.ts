/**
 * Zod-free scope map for the two condash settings files, split out of
 * `config-schema.ts` so the boot-path scope-partition migrator can import it
 * without constructing the ~15 top-level zod schemas that `config-schema.ts`
 * builds at module load (≈45 ms). Same discipline as `config-migrate.ts`:
 * anything the pre-window path needs from the config layer lives in a module
 * with **no** `import 'zod'`.
 *
 * The three key arrays below are the canonical owner-per-key map. They mirror
 * the field groups in `config-schema.ts` exactly — `config-schema.ts` applies a
 * `satisfies Record<…key union…, z.ZodTypeAny>` on each field group so a drift
 * in either direction (a schema key without an array entry, or vice-versa) is a
 * compile error, and `config-schema.test.ts` re-asserts the equality at runtime
 * against the two strict schemas. Neither can silently drift.
 */

export type SettingsScope = 'global' | 'conception';

/** Keys owned by the per-conception `.condash/settings.json`. Mirrors
 *  `conceptionOnlyFields` in `config-schema.ts` (minus the shared `$schema_doc`
 *  doc pointer, which is allowed in either file). */
export const CONCEPTION_ONLY_KEYS = [
  'workspace_path',
  'worktrees_path',
  'repositories',
  'retired_apps',
  'long_lived_branches',
  'taskConfig',
] as const;

/** Keys owned by the per-machine global `settings.json` proper. Mirrors
 *  `globalOnlyFields` in `config-schema.ts` (minus `$schema_doc`). */
export const GLOBAL_ONLY_KEYS = [
  'agents',
  'open_with',
  'pdf_viewer',
  'terminal',
  'dashboard',
  'autoSync',
  'theme',
  'uiFonts',
  'layout',
  'welcome',
  'cardMinWidth',
  'treeExpansion',
  'selectedBranches',
  'branchFilterStickyAll',
] as const;

/** Path-tracking keys the global file owns exclusively — a conception cannot
 *  describe its own location. Mirrors `pathTrackingFields` in `config-schema.ts`. */
export const PATH_TRACKING_KEYS = ['lastConceptionPath', 'recentConceptionPaths'] as const;

/** Skills-pane active scope — a per-machine UI-state key added directly to the
 *  global schema (outside the three field groups above). Global-owned. */
export const SKILLS_ACTIVE_SCOPE_KEY = 'skillsActiveScope' as const;

export type ConceptionOnlyKey = (typeof CONCEPTION_ONLY_KEYS)[number];
export type GlobalOnlyKey = (typeof GLOBAL_ONLY_KEYS)[number];
export type PathTrackingKey = (typeof PATH_TRACKING_KEYS)[number];

/**
 * Single source of truth for which file owns each top-level setting key. The
 * migrator, the CLI `config set`, and the Settings UI route a key to its owning
 * file through this map rather than re-encoding the split. `$schema_doc` is a
 * doc pointer allowed in either file and is intentionally absent.
 */
export const SCOPE_OF: Record<string, SettingsScope> = {
  ...Object.fromEntries(CONCEPTION_ONLY_KEYS.map((key) => [key, 'conception' as const])),
  ...Object.fromEntries(GLOBAL_ONLY_KEYS.map((key) => [key, 'global' as const])),
  ...Object.fromEntries(PATH_TRACKING_KEYS.map((key) => [key, 'global' as const])),
  [SKILLS_ACTIVE_SCOPE_KEY]: 'global',
};
