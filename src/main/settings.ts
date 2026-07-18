import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LayoutState, Settings } from '../shared/types';
import { DEFAULT_PROJECTS_SPLIT } from '../shared/types';
import { atomicWrite } from './atomic-write';
import { migrateRawSettings } from './config-migrate';
import { userDataDir } from './user-data-dir';

const FILE_NAME = 'settings.json';

/** Cap for `recentConceptionPaths`. Oldest entry evicted when prepending a
 * new one. Single constant so a future change is one line. */
export const RECENT_CONCEPTION_PATHS_CAP = 5;

// Serialise read-modify-write across the renderer's IPC verbs (setLayout,
// setTheme, setWelcomeDismissed, termSetPrefs, pickConceptionPath) so two
// concurrent calls don't drop one another's update. One queue is enough —
// settings.json is per-machine and small.
let settingsQueue: Promise<unknown> = Promise.resolve();
/** Run `work` serialised against every other settings.json write. Exported so
 * the Settings modal's raw save (`write-config.ts`) shares this queue with
 * `updateSettings` — two disjoint queues would let a narrow IPC mutation land
 * inside the raw save's read→write window and get silently overwritten. */
export function withSettingsQueue<T>(work: () => Promise<T>): Promise<T> {
  const next: Promise<T> = settingsQueue
    .catch(() => undefined)
    .then(work)
    // Every queued operation is a settings.json write (updateSettings,
    // mutateSettingsJson, and the Settings-modal raw save in write-config.ts all
    // funnel through here), so drop the read memo when one settles — the next
    // readSettings then re-reads the just-written file (S7). Runs on success and
    // failure alike; invalidating after a failed write is harmless.
    .finally(() => invalidateSettingsMemo());
  settingsQueue = next.catch(() => undefined);
  return next;
}

/**
 * Wait for every queued settings write to settle. Test-only surface —
 * `afterEach` calls this so the in-flight opportunistic rewrite from
 * `getTreeExpansion` (and any future fire-and-forget queue user)
 * finishes before the next test's `vi.doMock('../user-data-dir', …)`
 * swaps the path under it. Resolves once the chain is drained, even if
 * individual entries rejected.
 */
export async function drainSettingsQueue(): Promise<void> {
  await settingsQueue.catch(() => undefined);
}

export const DEFAULT_LAYOUT: LayoutState = {
  projects: true,
  leftView: 'projects',
  working: 'code',
  terminal: true,
  projectsSplit: DEFAULT_PROJECTS_SPLIT,
};

const empty: Settings = {
  lastConceptionPath: null,
  recentConceptionPaths: [],
  theme: 'system',
  terminal: {},
  layout: DEFAULT_LAYOUT,
};

export function settingsPath(): string {
  return join(userDataDir(), FILE_NAME);
}

/**
 * Migrate the legacy `conceptionPath` field forward.
 *
 * Pre-2.14 settings.json carried `conceptionPath: string | null`. The new
 * shape replaces it with `lastConceptionPath` plus a `recentConceptionPaths`
 * array. The migration is one-shot, idempotent, and signalled by the
 * absence of the old field — no version number on disk.
 */
function migrateLegacyShape(parsed: Record<string, unknown>): {
  lastConceptionPath: string | null;
  recentConceptionPaths: string[];
} {
  const legacy =
    typeof parsed.conceptionPath === 'string' || parsed.conceptionPath === null
      ? (parsed.conceptionPath as string | null)
      : undefined;
  const explicitLast =
    typeof parsed.lastConceptionPath === 'string' || parsed.lastConceptionPath === null
      ? (parsed.lastConceptionPath as string | null)
      : undefined;
  const explicitRecents = Array.isArray(parsed.recentConceptionPaths)
    ? (parsed.recentConceptionPaths.filter((p): p is string => typeof p === 'string') as string[])
    : undefined;

  // Prefer explicit new fields when present (re-launch after first migration).
  if (explicitLast !== undefined) {
    return {
      lastConceptionPath: explicitLast,
      recentConceptionPaths: explicitRecents ?? (explicitLast ? [explicitLast] : []),
    };
  }
  if (legacy !== undefined) {
    return {
      lastConceptionPath: legacy,
      recentConceptionPaths: legacy ? [legacy] : [],
    };
  }
  return {
    lastConceptionPath: null,
    recentConceptionPaths: explicitRecents ?? [],
  };
}

// Mtime+size-keyed read memo for settings.json.
//
// A single GUI boot calls readSettings ~20× (every IPC getter, some twice via
// getEffectiveConceptionConfig), each an unconditional readFile + JSON.parse +
// migrate of the same small file (review finding S7). The memo turns an
// unchanged file into a single `fs.stat`: on a hit (mtime AND size both
// unchanged since the cached parse) it returns the cached Settings without
// re-reading or re-parsing; on a miss it reads, parses, and stores.
//
// Every settings.json write funnels through `withSettingsQueue`, which drops
// this memo on completion, so condash's own writes always invalidate.
//
// Staleness contract: the key is (mtimeMs, size). fs.stat exposes ms-precision
// mtimes, so the only way to defeat the memo is an *external* editor writing the
// file within the same millisecond AND to the identical byte length — a
// vanishingly unlikely collision (any real edit changes content length or lands
// in a later millisecond), and it is accepted.
//
// The cached Settings object is returned by reference, NOT cloned: no caller
// mutates the result — every readSettings consumer either destructures fields or
// reads them, and every updateSettings mutator returns a fresh `{ ...cur }`
// spread rather than mutating `cur` in place (audited across the codebase). Same
// read-only sharing contract as parseReadmeCached. Treat the result as immutable.
interface SettingsMemoEntry {
  mtimeMs: number;
  size: number;
  settings: Settings;
}
let settingsMemo: SettingsMemoEntry | null = null;

/** Drop the settings.json read memo. Called from `withSettingsQueue` after every
 *  write so the next read re-reads from disk. Exported for tests. */
export function invalidateSettingsMemo(): void {
  settingsMemo = null;
}

/**
 * Move a corrupt `settings.json` aside so the next boot starts clean, logging
 * what happened. Best-effort: a rename failure (permissions, cross-device) is
 * logged and swallowed — booting with defaults still beats not booting.
 *
 * @param path Absolute path of the corrupt settings file.
 * @param err The `JSON.parse` SyntaxError that flagged the corruption.
 */
export async function quarantineCorruptSettings(path: string, err: unknown): Promise<void> {
  const asidePath = `${path}.corrupt-${Date.now()}`;
  const detail = (err as Error).message;
  try {
    await fs.rename(path, asidePath);
    process.stderr.write(
      `condash: ${FILE_NAME} is corrupt (${detail}); renamed to ${asidePath} — using defaults\n`,
    );
  } catch (renameErr) {
    process.stderr.write(
      `condash: ${FILE_NAME} is corrupt (${detail}) and could not be renamed aside ` +
        `(${(renameErr as Error).message}) — using defaults\n`,
    );
  }
}

/** Build the typed `Settings` view from settings.json's raw text. Shared by the
 *  memoised reader; assumes the file has already been stat'd. */
function buildSettings(raw: string): Settings {
  const rawParsed: unknown = JSON.parse(raw);
  // A degenerate root (`null`, a string, an array) must not crash boot —
  // fall back to defaults, same guard as effective-config's reader.
  if (!rawParsed || typeof rawParsed !== 'object' || Array.isArray(rawParsed)) {
    return { ...empty };
  }
  // Normalise legacy shapes (leftView 'outputs', dropped terminal keys, …)
  // before the typed view is built, so e.g. getLayout never surfaces an
  // unmigrated value to the renderer.
  const parsed = migrateRawSettings(rawParsed) as Record<string, unknown>;
  const { lastConceptionPath, recentConceptionPaths } = migrateLegacyShape(parsed);
  // Strip the legacy key from the parsed view so the spread below doesn't
  // re-add it to the in-memory Settings shape.
  const { conceptionPath: _drop, ...rest } = parsed as Record<string, unknown> & {
    conceptionPath?: unknown;
  };
  void _drop;
  const layoutCandidate =
    rest.layout && typeof rest.layout === 'object' ? (rest.layout as LayoutState) : undefined;
  return {
    ...empty,
    ...(rest as Partial<Settings>),
    lastConceptionPath,
    recentConceptionPaths: pruneRecents(recentConceptionPaths),
    layout: { ...DEFAULT_LAYOUT, ...(layoutCandidate ?? {}) },
  };
}

async function readSettingsFromDisk(): Promise<Settings> {
  const path = settingsPath();
  // Stat first: a cache hit costs one `stat` and skips the readFile + parse.
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      settingsMemo = null;
      return { ...empty };
    }
    throw err;
  }
  const memo = settingsMemo;
  if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) {
    return memo.settings;
  }
  try {
    const raw = await fs.readFile(path, 'utf8');
    const settings = buildSettings(raw);
    settingsMemo = { mtimeMs: stat.mtimeMs, size: stat.size, settings };
    return settings;
  } catch (err) {
    // TOCTOU: the file may have been removed between stat and read.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      settingsMemo = null;
      return { ...empty };
    }
    // A corrupt file — a hand-edit, a half-written external save, disk
    // corruption — makes `buildSettings`' JSON.parse throw a SyntaxError. This
    // read is on the un-caught `whenReady` chain (index.ts), so rethrowing here
    // would leave `createWindow` un-run and, on Linux, the process lingering
    // headless. Rescue boot instead: move the corrupt file aside and return
    // defaults. Losing `lastConceptionPath` beats not starting (B1). No dialog:
    // settings.ts is on the CLI (plain-Node) read path and must not import
    // electron — the stderr line is the surfaced signal.
    if (err instanceof SyntaxError) {
      await quarantineCorruptSettings(path, err);
      settingsMemo = null;
      return { ...empty };
    }
    throw err;
  }
}

async function readSettingsRaw(): Promise<Settings> {
  const onDisk = await readSettingsFromDisk();
  // CONDASH_CONCEPTION_PATH wins for the session — one-shot override
  // matching the Tauri build's behaviour. Read-side only: the write path
  // (`updateSettings`) starts from the on-disk state so a mutation under the
  // env var never persists the scratch path into `lastConceptionPath`.
  const envOverride = process.env.CONDASH_CONCEPTION_PATH;
  if (envOverride) return { ...onDisk, lastConceptionPath: envOverride };
  return onDisk;
}

export function readSettings(): Promise<Settings> {
  return readSettingsRaw();
}

/**
 * Prepend `path` to a recents list, dedup, and cap. The result is a fresh
 * array (the original is not mutated). An empty / null path is a no-op.
 */
export function prependRecent(recents: string[], path: string | null): string[] {
  if (!path) return pruneRecents(recents);
  const dedup = recents.filter((p) => p !== path);
  return pruneRecents([path, ...dedup]);
}

/** Coerce a recents array to clean string list, capped. */
function pruneRecents(recents: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of recents) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= RECENT_CONCEPTION_PATHS_CAP) break;
  }
  return out;
}

/**
 * Drop a path from the recents list. Returns a fresh array. The caller is
 * responsible for deciding whether `lastConceptionPath` should also clear
 * when the dropped path matches it.
 */
export function removeRecent(recents: string[], path: string): string[] {
  return recents.filter((p) => p !== path);
}

// `tmp → fsync → rename → dir-fsync`: a `fs.writeFile` truncate-then-write
// window can leave settings.json zero-length on power-loss, and an unsynced
// parent directory can lose the rename even though the file data synced; the
// `welcome.dismissed` flag is small but losing the lastConceptionPath bricks
// the next launch. `atomicWrite` (the shared writer) covers both fsyncs plus
// best-effort tmp cleanup on failure.
async function writeSettingsRaw(next: Settings): Promise<void> {
  const path = settingsPath();
  await fs.mkdir(dirname(path), { recursive: true });
  // Always cap recents on write so any in-memory mutation that grew the
  // list past the cap is normalised before it hits disk.
  const persisted: Settings = {
    ...next,
    recentConceptionPaths: pruneRecents(next.recentConceptionPaths ?? []),
  };
  await atomicWrite(path, JSON.stringify(persisted, null, 2) + '\n');
}

/**
 * Atomic read-modify-write. Use this for every IPC verb that mutates a
 * narrow field (setLayout, setTheme, setWelcomeDismissed, termSetPrefs,
 * pickConceptionPath) so two concurrent calls don't drop one another's
 * update. The mutator runs against fresh on-disk state under the
 * settings queue — deliberately *without* the `CONDASH_CONCEPTION_PATH`
 * overlay, so a mutation made while the env override is set doesn't
 * persist the session-only scratch path into `lastConceptionPath`.
 */
export async function updateSettings(
  mutator: (current: Settings) => Settings | Promise<Settings>,
): Promise<Settings> {
  return withSettingsQueue(async () => {
    const current = await readSettingsFromDisk();
    const next = await mutator(current);
    await writeSettingsRaw(next);
    return next;
  });
}

/**
 * Raw atomic read-modify-write of settings.json as an untyped JSON object,
 * run under the same `settingsQueue` as `updateSettings` so the GUI's typed
 * mutations and a CLI `config set --global` can't race and drop one another.
 *
 * Unlike `updateSettings` this neither migrates the legacy `conceptionPath`
 * field nor normalises through the `Settings` shape — it persists exactly the
 * object the mutator leaves, which is what the dotted-path `config set` needs
 * (arbitrary keys, no schema coercion). A missing file reads as `{}`; the
 * parent directory is created on write.
 *
 * @param mutator mutates the parsed JSON object in place
 */
export async function mutateSettingsJson(
  mutator: (current: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  return withSettingsQueue(async () => {
    const path = settingsPath();
    let current: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Missing file reads as an empty object; the mutator will create it.
      } else if (err instanceof SyntaxError) {
        // A corrupt file — hand-edit, external tool, disk truncation — would
        // otherwise brick CLI `config set --global` and the Settings modal raw
        // save. Recover the same way the boot reader does: quarantine the bad
        // file and start from `{}` so the mutator writes a valid replacement.
        await quarantineCorruptSettings(path, err);
      } else {
        throw err;
      }
    }
    await mutator(current);
    await fs.mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, JSON.stringify(current, null, 2) + '\n');
  });
}
