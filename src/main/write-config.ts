import { promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';
import { atomicWrite } from './atomic-write';
import { isConceptionSettingsPath } from './condash-dir';
import { withFileQueue } from './mutate-shared';
import { readSettings, settingsPath, withSettingsQueue } from './settings';

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
  // The global per-machine settings.json is matched by its EXACT path, never by
  // basename — so an in-tree note that merely shares the name (an exported
  // sample, another tool's `settings.json`) saves as a plain note instead of
  // being canonicalised against — and rejected by — the global schema (B4).
  const isGlobalSettings = path === settingsPath();
  // The canonical conception config lives at `<conception>/.condash/settings.json`
  // (dir-gated by `isConceptionSettingsPath`). The two legacy names at the
  // conception root (`condash.json`, `configuration.json`) are still recognised
  // — keeps `condash config set` working against an unmigrated file — but ONLY
  // when the file sits directly at the conception root. A sample/exported
  // `configuration.json` edited elsewhere in the tree is a plain note, not
  // config (which would either throw a baffling `Unrecognized key` or silently
  // reformat it — B4).
  const isConceptionConfig =
    isConceptionSettingsPath(path) ||
    ((baseName === 'condash.json' || baseName === 'configuration.json') &&
      (await isAtConceptionRoot(path)));

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
    // `config-schema` (≈45 ms of zod schema construction) is dynamic-imported on
    // the config/settings save branch only, so this module — reachable on the
    // pre-window boot path via the `mutate` barrel — stays off the eager zod
    // graph (S4). A plain README/note save never loads it.
    if (isConceptionConfig) {
      const { validateAndCanonicaliseConceptionConfig } = await import('./config-schema');
      finalContent = validateAndCanonicaliseConceptionConfig(newContent);
    } else if (isGlobalSettings) {
      const { validateAndCanonicaliseGlobalSettings } = await import('./config-schema');
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

/** True when `path` sits directly at the active conception root — the only
 *  place a legacy `condash.json` / `configuration.json` is treated as config
 *  rather than a plain note. */
async function isAtConceptionRoot(path: string): Promise<boolean> {
  const { lastConceptionPath } = await readSettings();
  return lastConceptionPath !== null && dirname(path) === lastConceptionPath;
}
