import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LayoutState, Settings } from '../shared/types';
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
function withSettingsQueue<T>(work: () => Promise<T>): Promise<T> {
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

async function readSettingsRaw(): Promise<Settings> {
  let onDisk: Settings;
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { lastConceptionPath, recentConceptionPaths } = migrateLegacyShape(parsed);
    // Strip the legacy key from the parsed view so the spread below doesn't
    // re-add it to the in-memory Settings shape.
    const { conceptionPath: _drop, ...rest } = parsed as Record<string, unknown> & {
      conceptionPath?: unknown;
    };
    void _drop;
    const layoutCandidate =
      rest.layout && typeof rest.layout === 'object' ? (rest.layout as LayoutState) : undefined;
    onDisk = {
      ...empty,
      ...(rest as Partial<Settings>),
      lastConceptionPath,
      recentConceptionPaths: pruneRecents(recentConceptionPaths),
      layout: { ...DEFAULT_LAYOUT, ...(layoutCandidate ?? {}) },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') onDisk = { ...empty };
    else throw err;
  }
  // CONDASH_CONCEPTION_PATH wins for the session — one-shot override
  // matching the Tauri build's behaviour.
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

// `tmp → fsync → rename`: a `fs.writeFile` truncate-then-write window can
// leave settings.json zero-length on power-loss; the `welcome.dismissed`
// flag is small but losing the lastConceptionPath bricks the next launch.
async function writeSettingsRaw(next: Settings): Promise<void> {
  const path = settingsPath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`);
  const fh = await fs.open(tmp, 'w');
  try {
    // Always cap recents on write so any in-memory mutation that grew the
    // list past the cap is normalised before it hits disk.
    const persisted: Settings = {
      ...next,
      recentConceptionPaths: pruneRecents(next.recentConceptionPaths ?? []),
    };
    await fh.writeFile(JSON.stringify(persisted, null, 2) + '\n', 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}

/**
 * Atomic read-modify-write. Use this for every IPC verb that mutates a
 * narrow field (setLayout, setTheme, setWelcomeDismissed, termSetPrefs,
 * pickConceptionPath) so two concurrent calls don't drop one another's
 * update. The mutator runs against fresh on-disk state under the
 * settings queue.
 */
export async function updateSettings(
  mutator: (current: Settings) => Settings | Promise<Settings>,
): Promise<Settings> {
  return withSettingsQueue(async () => {
    const current = await readSettingsRaw();
    const next = await mutator(current);
    await writeSettingsRaw(next);
    return next;
  });
}
