/**
 * One-shot, idempotent migrator that partitions a machine's settings into the
 * post-revamp layout: every setting key lives in exactly one file, decided by
 * `SCOPE_OF`. A key found in the wrong file is moved to its owning file; when
 * the owning file already carries that key, the misplaced copy is dropped
 * (owned-file value wins) and reported.
 *
 * Runs on every conception open, right after `migrateLegacyConfig` has lifted
 * any legacy `condash.json` / `configuration.json` into the canonical
 * `<conception>/.condash/settings.json`. Idempotent: once both files are
 * partitioned, a re-run finds nothing misplaced and writes nothing.
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic-write';
import { condashSettingsPath } from './condash-dir';
import { settingsPath } from './settings';
import { SCOPE_OF, type SettingsScope } from './config-schema';
import { migrateRawSettings } from './config-migrate';

/** A misplaced key whose copy was dropped because the owning file already
 *  carried that key. `droppedFrom` is the file the dropped copy came from. */
export interface ScopeMigrationDrop {
  key: string;
  droppedFrom: SettingsScope;
}

export interface ScopeMigrationResult {
  conception: string;
  /** Conception-file keys lifted into the global file. */
  movedToGlobal: string[];
  /** Global-file keys pushed down into the conception file. */
  movedToConception: string[];
  /** Misplaced keys dropped in favour of the owning file's existing value. */
  dropped: ScopeMigrationDrop[];
  globalWritten: boolean;
  conceptionWritten: boolean;
}

/** True when this migration changed anything (moved or dropped a key). */
export function scopeMigrationDidWork(result: ScopeMigrationResult): boolean {
  return (
    result.movedToGlobal.length > 0 ||
    result.movedToConception.length > 0 ||
    result.dropped.length > 0
  );
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = migrateRawSettings(JSON.parse(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function serialise(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Partition the global `settings.json` and the conception's
 * `.condash/settings.json` so each holds only the keys it owns. `$schema_doc`
 * is a doc pointer (not a setting) and stays in whichever file carries it;
 * keys absent from `SCOPE_OF` are left in place so an unrecognised key never
 * gets silently relocated.
 *
 * @param conception absolute path to the conception root
 * @param globalFile override for the global settings path (tests)
 */
export async function partitionSettingsScopes(
  conception: string,
  globalFile: string = settingsPath(),
): Promise<ScopeMigrationResult> {
  const conceptionFile = condashSettingsPath(conception);
  const [globalRaw, conceptionRaw] = await Promise.all([
    readJsonObject(globalFile),
    readJsonObject(conceptionFile),
  ]);

  const globalOut: Record<string, unknown> = {};
  const conceptionOut: Record<string, unknown> = {};
  const result: ScopeMigrationResult = {
    conception,
    movedToGlobal: [],
    movedToConception: [],
    dropped: [],
    globalWritten: false,
    conceptionWritten: false,
  };

  // Misplaced buckets — keys sitting in the file that does not own them.
  const toGlobal: Array<[string, unknown]> = []; // global-owned keys found in the conception file
  const toConception: Array<[string, unknown]> = []; // conception-owned keys found in the global file

  for (const [key, value] of Object.entries(globalRaw)) {
    const scope = key === '$schema_doc' ? 'global' : SCOPE_OF[key];
    if (scope === 'conception') toConception.push([key, value]);
    else globalOut[key] = value; // owned-global, $schema_doc, or unknown — keep
  }
  for (const [key, value] of Object.entries(conceptionRaw)) {
    const scope = key === '$schema_doc' ? 'conception' : SCOPE_OF[key];
    if (scope === 'global') toGlobal.push([key, value]);
    else conceptionOut[key] = value; // owned-conception, $schema_doc, or unknown — keep
  }

  // Route misplaced keys into their owning file; owned-file value wins.
  for (const [key, value] of toGlobal) {
    if (key in globalOut) result.dropped.push({ key, droppedFrom: 'conception' });
    else {
      globalOut[key] = value;
      result.movedToGlobal.push(key);
    }
  }
  for (const [key, value] of toConception) {
    if (key in conceptionOut) result.dropped.push({ key, droppedFrom: 'global' });
    else {
      conceptionOut[key] = value;
      result.movedToConception.push(key);
    }
  }

  // Each file changes only when a key entered or left it.
  const globalChanged =
    result.movedToGlobal.length > 0 ||
    result.movedToConception.length > 0 ||
    result.dropped.some((drop) => drop.droppedFrom === 'global');
  const conceptionChanged =
    result.movedToConception.length > 0 ||
    result.movedToGlobal.length > 0 ||
    result.dropped.some((drop) => drop.droppedFrom === 'conception');

  if (globalChanged) {
    await atomicWrite(globalFile, serialise(globalOut));
    result.globalWritten = true;
  }
  if (conceptionChanged) {
    await fs.mkdir(dirname(conceptionFile), { recursive: true });
    await atomicWrite(conceptionFile, serialise(conceptionOut));
    result.conceptionWritten = true;
  }

  return result;
}
