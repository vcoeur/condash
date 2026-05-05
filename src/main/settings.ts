import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LayoutState, Settings } from '../shared/types';
import { userDataDir } from './user-data-dir';

const FILE_NAME = 'settings.json';

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

export const DEFAULT_LAYOUT: LayoutState = {
  projects: true,
  working: 'code',
  terminal: true,
  projectsWidth: 320,
};

const empty: Settings = {
  conceptionPath: null,
  theme: 'system',
  terminal: {},
  layout: DEFAULT_LAYOUT,
};

export function settingsPath(): string {
  return join(userDataDir(), FILE_NAME);
}

async function readSettingsRaw(): Promise<Settings> {
  let onDisk: Settings;
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Layout is an object — shallow-merge with the default so an older
    // settings file that lacks a freshly-added field still resolves.
    onDisk = {
      ...empty,
      ...parsed,
      layout: { ...DEFAULT_LAYOUT, ...(parsed.layout ?? {}) },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') onDisk = { ...empty };
    else throw err;
  }
  // CONDASH_CONCEPTION_PATH wins for the session — one-shot override
  // matching the Tauri build's behaviour.
  const envOverride = process.env.CONDASH_CONCEPTION_PATH;
  if (envOverride) return { ...onDisk, conceptionPath: envOverride };
  return onDisk;
}

export function readSettings(): Promise<Settings> {
  return readSettingsRaw();
}

// `tmp → fsync → rename`: a `fs.writeFile` truncate-then-write window can
// leave settings.json zero-length on power-loss; the `welcome.dismissed`
// flag is small but losing the conceptionPath bricks the next launch.
async function writeSettingsRaw(next: Settings): Promise<void> {
  const path = settingsPath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(next, null, 2) + '\n', 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}

export function writeSettings(next: Settings): Promise<void> {
  return withSettingsQueue(() => writeSettingsRaw(next));
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
