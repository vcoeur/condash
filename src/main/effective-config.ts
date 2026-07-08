import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigShape } from './config-walk';
import type {
  Agent,
  CardMinWidthPrefs,
  DashboardSettings,
  LayoutState,
  TaskConfigEntry,
  TerminalPrefs,
  Theme,
  TreeExpansionPrefs,
} from '../shared/types';
import {
  CONDASH_DIR,
  CONDASH_SETTINGS_FILENAME,
  condashSettingsPath,
  isTombstone,
  legacyCondashJsonPath,
  legacyConfigurationJsonPath,
} from './condash-dir';
import { settingsPath } from './settings';
import { migrateRawSettings } from './config-migrate';
import { atomicWrite } from './atomic-write';
import { withFileQueue } from './mutate-shared';

/**
 * Single read surface over the two settings files. Reads the per-machine
 * `settings.json` (personal/app settings) and the per-conception settings
 * file (this tree's paths, repos, tasks), then spreads them into one view.
 *
 * The two schemas are **disjoint** (`SCOPE_OF` in `config-schema.ts`): no
 * setting key lives in both files, so the spread can never collide and there
 * is no precedence to reason about. The override model — top-level replace
 * plus the one-level-deep `terminal` / `dashboard` merges — was removed when
 * every key was given exactly one home.
 *
 * `lastConceptionPath` and `recentConceptionPaths` live exclusively on the
 * global side and are never included in the merged view — a conception
 * cannot describe its own location, by design.
 *
 * The per-conception file lives at `<conception>/.condash/settings.json`
 * (canonical), with two legacy fallbacks: `<conception>/condash.json` and
 * `<conception>/configuration.json`. The migrator (`condash-dir-migrate`)
 * lifts legacy files into the canonical location.
 */
export interface EffectiveConfig extends ConfigShape {
  workspace_path?: string;
  worktrees_path?: string;
  long_lived_branches?: string[];
  open_with?: Record<string, { label?: string; command: string }>;
  pdf_viewer?: string[];
  terminal?: TerminalPrefs;
  theme?: Theme;
  cardMinWidth?: CardMinWidthPrefs;
  layout?: LayoutState;
  treeExpansion?: TreeExpansionPrefs;
  agents?: Agent[];
  taskConfig?: Record<string, TaskConfigEntry>;
  dashboard?: DashboardSettings;
}

/**
 * Resolve the conception config file path that should be **read**. Probes
 * in priority order: `.condash/settings.json` → `condash.json` →
 * `configuration.json`, skipping migrator tombstones the same way
 * `readConceptionConfigRaw` does. Returns the canonical path (new primary)
 * for empty trees so the GUI can create it on first save.
 */
export async function resolveConceptionConfigPath(conceptionPath: string): Promise<string> {
  const candidates = [
    condashSettingsPath(conceptionPath),
    legacyCondashJsonPath(conceptionPath),
    legacyConfigurationJsonPath(conceptionPath),
  ];
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    // A tombstoned legacy file must not shadow the next candidate — match
    // readConceptionConfigRaw's probing. Malformed JSON still resolves to
    // this candidate (same surface as the previous exists-only check).
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && isTombstone(parsed as Record<string, unknown>)) {
        continue;
      }
    } catch {
      // Fall through — the file exists, even if unparseable.
    }
    return candidate;
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
 * Atomic read-modify-write of a conception's config file — the conception-side
 * analog of `updateSettings` for the per-machine `settings.json`. Reads the
 * canonical `.condash/settings.json` (seeding from the legacy fallbacks when the
 * canonical primary doesn't exist yet, so the first write never drops keys the
 * user still keeps in a legacy `condash.json`), runs `mutator` against the
 * parsed object, then writes it back to the canonical path. Serialised per write
 * path so two concurrent conception-config mutations can't drop one another's
 * update.
 *
 * @param conceptionPath active conception root
 * @param mutator mutates the parsed config object in place
 */
export async function mutateConceptionConfig(
  conceptionPath: string,
  mutator: (config: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  const writePath = conceptionConfigWritePath(conceptionPath);
  return withFileQueue(writePath, async () => {
    let current: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(writePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (Object.keys(current).length === 0) {
      current = await readConceptionConfigRaw(conceptionPath);
    }
    await mutator(current);
    await fs.mkdir(dirname(writePath), { recursive: true });
    await atomicWrite(writePath, JSON.stringify(current, null, 2) + '\n');
  });
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

// Mtime+size-keyed read memo for the merged effective config (review finding B4).
//
// The dashboard engine (15 s), the task scheduler (20 s), and several IPC getters
// all call `getEffectiveConceptionConfig`, each an unconditional read + JSON.parse
// + migrate of BOTH the global `settings.json` and the conception config file.
// With N idle terminal tabs those ticks re-derive an identical object every few
// seconds. The memo turns an unchanged pair of files into two `fs.stat`s: on a hit
// (both files' mtimeMs AND size unchanged, and the same resolved conception
// candidate) it returns the cached merged view without re-reading or re-parsing;
// on a miss it reads, merges, and stores.
//
// Keyed on (mtimeMs, size) of the global settings file and of whichever
// conception candidate actually resolved — the canonical
// `.condash/settings.json`, else the legacy `condash.json` / `configuration.json`
// fallbacks (first existing in read-priority order). A single slot keyed on
// (conceptionPath, settingsFile) is enough: there is one active conception, and a
// query with different paths simply misses and re-reads (never returns stale).
//
// Stat-per-read means NO explicit invalidation wiring is needed: condash's own
// writes (via `mutateConceptionConfig` / `updateSettings` / `mutateSettingsJson`)
// bump the file mtime, and so does any external editor, so the next read observes
// the change. The only way to defeat the memo is an edit landing in the same
// millisecond AND at the identical byte length — a vanishingly unlikely collision,
// accepted (the same staleness contract as the settings.ts read memo).
//
// The cached object is returned BY REFERENCE, not cloned: no caller mutates the
// result — every reader (`repos.ts`, `worktree-ops.ts`, `launchers.ts`,
// `audit.ts`, `terminals.ts`, `path-bounds.ts`, the dashboard/scheduler ticks, the
// IPC getters, the CLI `config` verbs) either reads scalar fields, spreads them
// into a fresh object, or serialises the result over IPC (audited across the
// codebase). Same read-only sharing contract as the settings.ts / parseReadme
// memos. Treat the result as immutable — INCLUDING nested objects (`terminal`,
// `repositories[]` entries, `taskConfig`): mutating a nested leaf silently
// poisons the cache for every reader until the next file change. To change
// config, go through updateSettings / mutateConceptionConfig, never by editing
// what this returns.
interface FileStatKey {
  /** Absolute path stat'd (the resolved candidate), or '' when none exists. */
  path: string;
  mtimeMs: number;
  size: number;
}
const ABSENT_STAT_KEY: FileStatKey = { path: '', mtimeMs: -1, size: -1 };

interface EffectiveConfigMemoEntry {
  conceptionPath: string;
  settingsFile: string;
  globalKey: FileStatKey;
  conceptionKey: FileStatKey;
  value: EffectiveConfig;
}
let effectiveConfigMemo: EffectiveConfigMemoEntry | null = null;

/** Drop the effective-config read memo. Stat-per-read makes this unnecessary in
 *  production (writes bump mtime); exported for test isolation. */
export function invalidateEffectiveConfigMemo(): void {
  effectiveConfigMemo = null;
}

function fileStatKeyEqual(a: FileStatKey, b: FileStatKey): boolean {
  return a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** Stat `file`, returning its identity key or the absent sentinel on ENOENT. */
async function statFileKey(file: string): Promise<FileStatKey> {
  try {
    const st = await fs.stat(file);
    return { path: file, mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...ABSENT_STAT_KEY };
    throw err;
  }
}

/** Identity key for the conception config: the first existing candidate in
 *  read-priority order (canonical `.condash/settings.json`, then the legacy
 *  `condash.json` / `configuration.json` fallbacks), so the memo re-reads only
 *  when the file that actually resolved changes. Absent sentinel when none exist.
 *  A tombstoned legacy file is never the first existing candidate in a real tree
 *  (the migrator writes the canonical file whenever it tombstones a legacy one),
 *  so keying on first-existing tracks the resolved file; the read path still
 *  skips tombstones itself on a miss. */
async function statConceptionKey(conceptionPath: string): Promise<FileStatKey> {
  const candidates = [
    condashSettingsPath(conceptionPath),
    legacyCondashJsonPath(conceptionPath),
    legacyConfigurationJsonPath(conceptionPath),
  ];
  for (const candidate of candidates) {
    const key = await statFileKey(candidate);
    if (key.path) return key;
  }
  return { ...ABSENT_STAT_KEY };
}

/**
 * Compute the effective config for a conception. With disjoint schemas no
 * setting key can appear in both files, so this is a plain spread that can
 * never collide. The path-tracking keys stay global-only and never enter the
 * effective view. Memoised on both files' (mtimeMs, size) — see the memo note
 * above — so an unchanged pair of files costs two stats instead of two full
 * read+parse+migrate passes.
 */
export async function getEffectiveConceptionConfig(
  conceptionPath: string,
  settingsFile: string = settingsPath(),
): Promise<EffectiveConfig> {
  // Stat both inputs first: a cache hit costs these two stats and skips the
  // read + JSON.parse + migrate of both files.
  const [globalKey, conceptionKey] = await Promise.all([
    statFileKey(settingsFile),
    statConceptionKey(conceptionPath),
  ]);
  const memo = effectiveConfigMemo;
  if (
    memo &&
    memo.conceptionPath === conceptionPath &&
    memo.settingsFile === settingsFile &&
    fileStatKeyEqual(memo.globalKey, globalKey) &&
    fileStatKeyEqual(memo.conceptionKey, conceptionKey)
  ) {
    return memo.value;
  }
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
  const value = merged as EffectiveConfig;
  effectiveConfigMemo = { conceptionPath, settingsFile, globalKey, conceptionKey, value };
  return value;
}

// Re-export the new constants from `./condash-dir` for callers that still
// import via this module. Centralising them in condash-dir.ts keeps the
// path layout in one file; the re-exports avoid a churn-only diff.
export { CONDASH_DIR, CONDASH_SETTINGS_FILENAME, condashSettingsPath };
