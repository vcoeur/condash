import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../shared/types';

const FILE_NAME = 'settings.json';

const empty: Settings = { conceptionPath: null, theme: 'system' };

function settingsPath(): string {
  return join(app.getPath('userData'), FILE_NAME);
}

export async function readSettings(): Promise<Settings> {
  let onDisk: Settings;
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    onDisk = { ...empty, ...parsed };
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

export async function writeSettings(next: Settings): Promise<void> {
  const path = settingsPath();
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
}
