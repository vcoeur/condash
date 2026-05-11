import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ConfigShape } from './config-walk';
import type {
  CardMinWidthPrefs,
  LayoutState,
  TerminalPrefs,
  Theme,
  TreeExpansionPrefs,
} from '../shared/types';
import { settingsPath } from './settings';

/**
 * Two-layer config resolver. Reads the per-machine `settings.json` for
 * workspace-shape defaults and the per-conception `condash.json` (or its
 * legacy fallback `configuration.json`) for the override layer, then
 * top-level-merges with conception winning. `lastConceptionPath` and
 * `recentConceptionPaths` live exclusively on the global side and are
 * never included in the merged view — a conception cannot describe its
 * own location, by design.
 *
 * "Top-level replace" semantics: each top-level key in the conception
 * config replaces the matching key in the global settings entirely. Arrays
 * replace; objects replace whole. No deep merge — predictable beats
 * convenient. A conception that wants to override only one `open_with`
 * slot has to restate the others.
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

/** Filename condash now writes to. */
export const CONCEPTION_CONFIG_FILENAME = 'condash.json';

/** Legacy filename — read indefinitely as a fallback so existing trees
 * keep working without forced migration. Writes always target
 * `condash.json`; the user can delete the legacy file at their leisure. */
export const LEGACY_CONCEPTION_CONFIG_FILENAME = 'configuration.json';

/**
 * Resolve the conception config file path that should be **read**. Returns
 * the canonical path (`condash.json`) when present, falling back to
 * `configuration.json` when only the legacy file exists. Returns the
 * canonical path for empty trees so the GUI can create it on first save.
 */
export async function resolveConceptionConfigPath(conceptionPath: string): Promise<string> {
  const canonical = join(conceptionPath, CONCEPTION_CONFIG_FILENAME);
  if (await fileExists(canonical)) return canonical;
  const legacy = join(conceptionPath, LEGACY_CONCEPTION_CONFIG_FILENAME);
  if (await fileExists(legacy)) return legacy;
  return canonical;
}

/** Path the GUI / CLI should **write** to. Always `condash.json`. */
export function conceptionConfigWritePath(conceptionPath: string): string {
  return join(conceptionPath, CONCEPTION_CONFIG_FILENAME);
}

/**
 * Read the conception config file (preferring `condash.json`, falling
 * back to `configuration.json`). Returns the parsed JSON or `{}` if no
 * file exists. Malformed JSON throws — same surface as the previous
 * direct readers.
 */
export async function readConceptionConfigRaw(
  conceptionPath: string,
): Promise<Record<string, unknown>> {
  for (const filename of [CONCEPTION_CONFIG_FILENAME, LEGACY_CONCEPTION_CONFIG_FILENAME]) {
    try {
      const raw = await fs.readFile(join(conceptionPath, filename), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return {};
}

/** Read settings.json's raw JSON (no shape coercion beyond JSON.parse). */
async function readGlobalSettingsRaw(settingsFile: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(settingsFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

const GLOBAL_ONLY_KEYS = new Set(['lastConceptionPath', 'recentConceptionPaths', 'conceptionPath']);

/**
 * Compute the effective config for a conception by merging the global
 * settings.json's workspace fields with the conception's condash.json
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
    merged[key] = value;
  }
  return merged as EffectiveConfig;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
