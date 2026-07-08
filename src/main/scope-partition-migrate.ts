/**
 * One-shot, idempotent migrator that partitions a machine's settings into the
 * post-revamp layout: every setting key lives in exactly one file, decided by
 * `SCOPE_OF`. A key found in the wrong file is moved to its owning file; when
 * the owning file already carries that key, an object value is **deep-merged**
 * into the owner (owner leaf wins, so disjoint sub-keys split across the two
 * files — e.g. `terminal.screenshot_dir` in global + `terminal.logging` in the
 * conception — survive), while a scalar / array value is dropped (owner wins
 * wholesale). All of it is reported.
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
import { settingsPath, withSettingsQueue } from './settings';
import { withFileQueue } from './mutate-shared';
import { SCOPE_OF, type SettingsScope } from './config-scope';
import { migrateRawSettings } from './config-migrate';

/** A misplaced key whose copy was dropped because the owning file already
 *  carried that key. `droppedFrom` is the file the dropped copy came from. */
export interface ScopeMigrationDrop {
  key: string;
  droppedFrom: SettingsScope;
}

/** A misplaced **object** key whose sub-keys were deep-merged into the owning
 *  file's existing object instead of dropped, so disjoint sub-keys split across
 *  the two files survive (e.g. `terminal.screenshot_dir` in global +
 *  `terminal.logging` in the conception). `into` is the owning file. */
export interface ScopeMigrationMerge {
  key: string;
  into: SettingsScope;
}

export interface ScopeMigrationResult {
  conception: string;
  /** Conception-file keys lifted into the global file. */
  movedToGlobal: string[];
  /** Global-file keys pushed down into the conception file. */
  movedToConception: string[];
  /** Misplaced keys dropped in favour of the owning file's existing value. */
  dropped: ScopeMigrationDrop[];
  /** Misplaced object keys merged into the owning file's existing object. */
  merged: ScopeMigrationMerge[];
  globalWritten: boolean;
  conceptionWritten: boolean;
}

/** True when this migration changed anything (moved, merged, or dropped a key). */
export function scopeMigrationDidWork(result: ScopeMigrationResult): boolean {
  return (
    result.movedToGlobal.length > 0 ||
    result.movedToConception.length > 0 ||
    result.dropped.length > 0 ||
    result.merged.length > 0
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

/** A non-null, non-array object — the only shape we deep-merge. Arrays
 *  (`agents`, `repositories`, …) keep whole-value semantics on a conflict. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge `incoming` beneath `owner`, recursing into nested plain objects. The
 * owning file is authoritative: a key present on both sides keeps the owner's
 * value (recursing when both are plain objects), and only keys the owner lacks
 * are carried over from `incoming`. Returns the merged object plus whether the
 * owner gained anything — `changed: false` means `incoming` was a pure subset,
 * so the owning file needs no rewrite. Neither input is mutated.
 */
function deepMergeOwnerWins(
  owner: Record<string, unknown>,
  incoming: Record<string, unknown>,
): { value: Record<string, unknown>; changed: boolean } {
  const value: Record<string, unknown> = { ...owner };
  let changed = false;
  for (const [key, incomingVal] of Object.entries(incoming)) {
    if (!(key in value)) {
      value[key] = incomingVal;
      changed = true;
    } else if (isPlainObject(value[key]) && isPlainObject(incomingVal)) {
      const sub = deepMergeOwnerWins(value[key] as Record<string, unknown>, incomingVal);
      value[key] = sub.value;
      if (sub.changed) changed = true;
    }
    // else: the owner already holds a value here and it wins — no change.
  }
  return { value, changed };
}

/**
 * Route `misplaced` keys (sitting in the file that does not own them) into
 * `ownerOut`, the owning file's output. A key absent from the owner is moved
 * verbatim; a key already present is **deep-merged** when both values are plain
 * objects (owner leaf wins, disjoint sub-keys preserved — the
 * `terminal.{screenshot_dir,logging}` split) and otherwise dropped (owner value
 * wins wholesale, as for scalars and arrays). Mutates `ownerOut` and appends to
 * `result`; returns whether the owner gained sub-keys via a merge (the signal
 * that the owning file must be rewritten).
 */
function routeMisplaced(
  misplaced: Array<[string, unknown]>,
  ownerOut: Record<string, unknown>,
  ownerScope: SettingsScope,
  result: ScopeMigrationResult,
): boolean {
  const fromScope: SettingsScope = ownerScope === 'global' ? 'conception' : 'global';
  const movedList = ownerScope === 'global' ? result.movedToGlobal : result.movedToConception;
  let ownerGained = false;
  for (const [key, value] of misplaced) {
    const ownerVal = ownerOut[key];
    if (!(key in ownerOut)) {
      ownerOut[key] = value;
      movedList.push(key);
    } else if (isPlainObject(ownerVal) && isPlainObject(value)) {
      const merged = deepMergeOwnerWins(ownerVal, value);
      ownerOut[key] = merged.value;
      result.merged.push({ key, into: ownerScope });
      if (merged.changed) ownerGained = true;
    } else {
      result.dropped.push({ key, droppedFrom: fromScope });
    }
  }
  return ownerGained;
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
  // Hold both write queues across the whole read→compute→write. The global
  // read+write must sit inside `withSettingsQueue` so a concurrent
  // `updateSettings` (e.g. setTheme) can't land between this migrator's read of
  // the global file and its write-back and be silently dropped; likewise the
  // conception read+write must sit inside `withFileQueue(conceptionFile)`
  // against a concurrent `mutateConceptionConfig` / Settings-modal save. The
  // conception-file queue is the outer lock and the settings queue the inner
  // one — matching write-config's ordering (file queue outside, settings queue
  // inside) so the settings queue is always the innermost lock and the two can
  // never deadlock.
  return withFileQueue(conceptionFile, () =>
    withSettingsQueue(() => partitionUnlocked(conception, globalFile, conceptionFile)),
  );
}

/** Body of `partitionSettingsScopes`, run with both file queues already held.
 *  Reads both files, computes the partition, and writes back any file that
 *  changed. */
async function partitionUnlocked(
  conception: string,
  globalFile: string,
  conceptionFile: string,
): Promise<ScopeMigrationResult> {
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
    merged: [],
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

  // Route misplaced keys into their owning file: move when absent, deep-merge
  // when both sides are plain objects (disjoint sub-keys survive), else drop.
  const globalGained = routeMisplaced(toGlobal, globalOut, 'global', result);
  const conceptionGained = routeMisplaced(toConception, conceptionOut, 'conception', result);

  // A file changes when a key left it (every misplaced key is routed out of its
  // source file) or entered it (a move, or a merge that added sub-keys). The
  // misplaced buckets are the authority on what left: every `toConception` key
  // is removed from the global file regardless of how it lands, and likewise
  // every `toGlobal` key leaves the conception file.
  const globalChanged = toConception.length > 0 || result.movedToGlobal.length > 0 || globalGained;
  const conceptionChanged =
    toGlobal.length > 0 || result.movedToConception.length > 0 || conceptionGained;

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
