import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LayoutState, Settings } from '../shared/types';
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
  const next: Promise<T> = settingsQueue.catch(() => undefined).then(work);
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
  projectsWidth: 320,
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

async function readSettingsFromDisk(): Promise<Settings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...empty };
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
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await mutator(current);
    await fs.mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, JSON.stringify(current, null, 2) + '\n');
  });
}
