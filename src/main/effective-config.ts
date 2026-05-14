import { promises as fs } from 'node:fs';
import type { ConfigShape } from './config-walk';
import type {
  CardMinWidthPrefs,
  LayoutState,
  TerminalPrefs,
  Theme,
  TreeExpansionPrefs,
} from '../shared/types';
import {
  CONDASH_DIR,
  CONDASH_SETTINGS_FILENAME,
  LEGACY_CONDASH_JSON,
  LEGACY_CONFIGURATION_JSON,
  condashSettingsPath,
  legacyCondashJsonPath,
  legacyConfigurationJsonPath,
} from './condash-dir';
import { settingsPath } from './settings';
import { migrateRawSettings } from './config-schema';

/**
 * Two-layer config resolver. Reads the per-machine `settings.json` for
 * workspace-shape defaults and the per-conception settings file for the
 * override layer, then top-level-merges with conception winning.
 *
 * `lastConceptionPath` and `recentConceptionPaths` live exclusively on the
 * global side and are never included in the merged view — a conception
 * cannot describe its own location, by design.
 *
 * The per-conception file lives at `<conception>/.condash/settings.json`
 * (canonical), with two legacy fallbacks: `<conception>/condash.json` and
 * `<conception>/configuration.json`. The migrator (`condash-dir-migrate`)
 * lifts legacy files into the canonical location.
 *
 * "Top-level replace" semantics: each top-level key in the conception
 * config replaces the matching key in the global settings entirely. Arrays
 * replace; objects replace whole. No deep merge — predictable beats
 * convenient. A conception that wants to override only one `open_with`
 * slot has to restate the others.
 *
 * One exception: `terminal`. Its sub-schema straddles per-machine input /
 * device prefs (`shell`, `shortcut`, `screenshot_dir`, `launchers`,
 * `xterm`, …) and per-tree retention policy (`logging.{retentionDays,
 * maxDirMb, …}`). A pure replace meant any tree that customised
 * `terminal.logging` silently lost every per-machine terminal pref — the
 * launcher buttons vanished and the screenshot-paste shortcut toasted
 * "no screenshot_dir". `terminal` therefore merges one level deep:
 * conception fields win at the sub-key level, missing sub-keys fall
 * through to the global block. Nested values inside `terminal.xterm` /
 * `terminal.logging` / `terminal.launchers` still replace whole — the
 * launchers array, in particular, replaces wholesale so a conception can
 * decisively swap in its own set rather than partially shadow.
 */
export interface EffectiveConfig extends ConfigShape {
  workspace_path?: string;
  worktrees_path?: string;
  resources_path?: string;
  skills_path?: string;
  open_with?: Record<string, { label?: string; command: string }>;
  pdf_viewer?: string[];
  terminal?: TerminalPrefs;
  theme?: Theme;
  cardMinWidth?: CardMinWidthPrefs;
  layout?: LayoutState;
  treeExpansion?: TreeExpansionPrefs;
}

/**
 * @deprecated Use `CONDASH_SETTINGS_FILENAME` and `condashSettingsPath()`
 * from `./condash-dir` instead. Kept exported for callers that still
 * reference the basename literal in error messages or comments.
 */
export const CONCEPTION_CONFIG_FILENAME = LEGACY_CONDASH_JSON;

/**
 * @deprecated The legacy² filename. Use the helpers in `./condash-dir`.
 */
export const LEGACY_CONCEPTION_CONFIG_FILENAME = LEGACY_CONFIGURATION_JSON;

/**
 * Resolve the conception config file path that should be **read**. Probes
 * in priority order: `.condash/settings.json` → `condash.json` →
 * `configuration.json`. Returns the canonical path (new primary) for empty
 * trees so the GUI can create it on first save.
 */
export async function resolveConceptionConfigPath(conceptionPath: string): Promise<string> {
  const candidates = [
    condashSettingsPath(conceptionPath),
    legacyCondashJsonPath(conceptionPath),
    legacyConfigurationJsonPath(conceptionPath),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  // Empty tree → return the new canonical so the GUI's first save lands
  // in the right place.
  return condashSettingsPath(conceptionPath);
}

/**
 * Path the GUI / CLI should **write** to. Always
 * `<conception>/.condash/settings.json` — the new canonical. Callers are
 * responsible for `mkdir -p` on the parent directory.
 */
export function conceptionConfigWritePath(conceptionPath: string): string {
  return condashSettingsPath(conceptionPath);
}

/**
 * Read the conception config file. Probes in priority order:
 *   1. `.condash/settings.json`
 *   2. `condash.json`
 *   3. `configuration.json`
 *
 * Returns the parsed JSON or `{}` when no file exists. Malformed JSON
 * throws — same surface as the previous direct readers.
 */
export async function readConceptionConfigRaw(
  conceptionPath: string,
): Promise<Record<string, unknown>> {
  const candidates = [
    condashSettingsPath(conceptionPath),
    legacyCondashJsonPath(conceptionPath),
    legacyConfigurationJsonPath(conceptionPath),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        // Tombstones (left in place by the migrator) carry only `_moved_*`
        // keys. Treat them as empty so a tombstoned legacy never shadows a
        // missing primary.
        const obj = parsed as Record<string, unknown>;
        if (isTombstone(obj)) continue;
        return migrateRawSettings(obj) as Record<string, unknown>;
      }
      return {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return {};
}

/** Read settings.json's raw JSON. Legacy shapes (`terminal.launcher_command`)
 *  are normalised in-flight by `migrateRawSettings` so every consumer sees
 *  the canonical schema. */
async function readGlobalSettingsRaw(settingsFile: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(settingsFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return migrateRawSettings(parsed) as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

const GLOBAL_ONLY_KEYS = new Set(['lastConceptionPath', 'recentConceptionPaths', 'conceptionPath']);

/**
 * Compute the effective config for a conception by merging the global
 * settings.json's workspace fields with the conception's settings file
 * (legacy fallback applied). Top-level replace; conception wins. The two
 * path-tracking keys never participate.
 */
export async function getEffectiveConceptionConfig(
  conceptionPath: string,
  settingsFile: string = settingsPath(),
): Promise<EffectiveConfig> {
  const [global, conception] = await Promise.all([
    readGlobalSettingsRaw(settingsFile),
    readConceptionConfigRaw(conceptionPath),
  ]);
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(global)) {
    if (GLOBAL_ONLY_KEYS.has(key)) continue;
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(conception)) {
    if (GLOBAL_ONLY_KEYS.has(key)) continue;
    if (key === 'terminal' && isPlainObject(value) && isPlainObject(merged.terminal)) {
      merged.terminal = { ...merged.terminal, ...value };
      continue;
    }
    merged[key] = value;
  }
  return merged as EffectiveConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when the parsed JSON looks like a migrator-written tombstone (no
 * config keys, only `_moved_*` markers). */
function isTombstone(obj: Record<string, unknown>): boolean {
  if (Object.keys(obj).length === 0) return false;
  for (const key of Object.keys(obj)) {
    if (!key.startsWith('_')) return false;
  }
  return true;
}

// Re-export the new constants from `./condash-dir` for callers that still
// import via this module. Centralising them in condash-dir.ts keeps the
// path layout in one file; the re-exports avoid a churn-only diff.
export { CONDASH_DIR, CONDASH_SETTINGS_FILENAME, condashSettingsPath };
