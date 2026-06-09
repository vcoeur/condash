import { promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';
import { atomicWrite } from './atomic-write';
import { isConceptionSettingsPath } from './condash-dir';
import {
  validateAndCanonicaliseConceptionConfig,
  validateAndCanonicaliseGlobalSettings,
} from './config-schema';
import { withFileQueue } from './mutate-shared';
import { withSettingsQueue } from './settings';

/**
 * Generic drift-checked note writer plus the settings/config canonicalisation
 * branch. This is the one README/note writer that needs config-schema
 * knowledge — it dispatches `condash.json` / `settings.json` saves through the
 * zod canonicalisers so the bytes that hit disk are schema-canonical. Keeping
 * it out of the step/status mutators leaves those free of the config layer.
 */
export async function writeNote(
  path: string,
  expectedContent: string,
  newContent: string,
): Promise<string> {
  const baseName = basename(path);
  // The canonical conception config lives at `<conception>/.condash/settings.json`
  // — same basename as the global per-machine `~/.config/condash/settings.json`,
  // so we disambiguate via the parent-directory check. The two legacy names at
  // the conception root (`condash.json`, `configuration.json`) are also handled
  // here even though the writer no longer targets them — keeps `condash
  // config set` working against a legacy file the user hasn't migrated yet.
  const isConceptionConfig =
    isConceptionSettingsPath(path) ||
    baseName === 'condash.json' ||
    baseName === 'configuration.json';
  const isGlobalSettings = baseName === 'settings.json' && !isConceptionSettingsPath(path);

  const work = async (): Promise<string> => {
    let onDisk = '';
    try {
      onDisk = await fs.readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // File doesn't exist yet — expected baseline must also be empty.
    }
    if (onDisk !== expectedContent) {
      throw new Error('File on disk has drifted; reload before saving');
    }

    let finalContent: string;
    if (isConceptionConfig) {
      finalContent = validateAndCanonicaliseConceptionConfig(newContent);
    } else if (isGlobalSettings) {
      finalContent = validateAndCanonicaliseGlobalSettings(newContent);
    } else {
      finalContent = newContent;
    }
    // The new canonical config lives in `.condash/`, which may not exist
    // yet when the user saves Settings for the first time on a fresh
    // conception. Ensure the parent dir before atomicWrite — cheap, and
    // covers any other future write to a not-yet-created subdir too.
    if (isConceptionSettingsPath(path)) {
      await fs.mkdir(dirname(path), { recursive: true });
    }
    await atomicWrite(path, finalContent);
    return finalContent;
  };

  // The global settings.json save additionally runs under the in-process
  // settings queue shared with `updateSettings`, so a narrow IPC mutation
  // (setLayout, setTheme, …) can't land inside this read→write window and be
  // silently overwritten — the raw save's drift check then fails loudly
  // instead. Failures are folded into a Result inside the queue and rethrown
  // out here: the promise withFileQueue retains internally would otherwise
  // surface every drift/validation error as an unhandled rejection.
  const result = await withFileQueue(path, () =>
    (isGlobalSettings ? withSettingsQueue(work) : work()).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  );
  if (!result.ok) throw result.error;
  return result.value;
}
