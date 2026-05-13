import { basename, dirname, join } from 'node:path';

/**
 * Single source of truth for the per-conception `.condash/` workspace
 * directory: the directory name, the canonical filenames inside it, and
 * the legacy filenames at the conception root that we still read as
 * fallbacks. Path helpers live here so every caller — main process, CLI,
 * IPC handlers — derives paths from the same constants.
 *
 * Layout:
 *
 *   <conception>/
 *     .condash/
 *       settings.json          ← new canonical config (was condash.json)
 *       logs/
 *         YYYY/MM/DD/
 *           HHMMSS-<sid>.jsonl ← one file per pty spawn
 *     condash.json             ← legacy primary (kept as fallback)
 *     configuration.json       ← legacy² (kept as fallback)
 *
 * `.condash/` is fully gitignored by default — every byte under it is
 * per-host state, including settings.json. Teams that want a shared
 * baseline either commit `condash.json` alongside (legacy path still
 * works) or un-ignore `settings.json` manually.
 */

export const CONDASH_DIR = '.condash';
export const CONDASH_SETTINGS_FILENAME = 'settings.json';
export const CONDASH_LOGS_SUBDIR = 'logs';

/** Legacy filenames at the conception root. Read indefinitely so existing
 * trees keep working; the migrator copies their content into
 * `.condash/settings.json` and tombstones the legacy file. */
export const LEGACY_CONDASH_JSON = 'condash.json';
export const LEGACY_CONFIGURATION_JSON = 'configuration.json';

/** Absolute path to `<conception>/.condash/`. */
export function condashDir(conception: string): string {
  return join(conception, CONDASH_DIR);
}

/** Absolute path to `<conception>/.condash/settings.json`. */
export function condashSettingsPath(conception: string): string {
  return join(conception, CONDASH_DIR, CONDASH_SETTINGS_FILENAME);
}

/** Absolute path to `<conception>/.condash/logs/`. */
export function condashLogsRoot(conception: string): string {
  return join(conception, CONDASH_DIR, CONDASH_LOGS_SUBDIR);
}

/** Absolute path to `<conception>/condash.json` (legacy, read-only). */
export function legacyCondashJsonPath(conception: string): string {
  return join(conception, LEGACY_CONDASH_JSON);
}

/** Absolute path to `<conception>/configuration.json` (legacy², read-only). */
export function legacyConfigurationJsonPath(conception: string): string {
  return join(conception, LEGACY_CONFIGURATION_JSON);
}

/**
 * Identify a conception-scoped settings.json by directory layout —
 * `.condash/settings.json` vs. the global per-machine settings.json that
 * shares the same basename. Used by `writeNote`'s schema-dispatch so a
 * conception save doesn't get canonicalised against the global schema.
 */
export function isConceptionSettingsPath(path: string): boolean {
  return basename(path) === CONDASH_SETTINGS_FILENAME && basename(dirname(path)) === CONDASH_DIR;
}
