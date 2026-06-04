import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { TerminalPrefs } from '../shared/types';
import { atomicWrite } from './atomic-write';
import { readSettings, updateSettings } from './settings';

/**
 * One-shot, boot-time settings migrations that move data between files as the
 * settings layout evolves. These are settings-evolution concerns, not the
 * live-state responsibility of the modules whose data they migrate, so they
 * live here rather than inside (e.g.) the PTY session manager.
 */

/**
 * One-shot migration: if settings.json has no terminal block but the
 * pre-existing configuration.json carries one, copy it over and strip
 * configuration.json. Idempotent — does nothing once settings.json owns
 * the data. (Dates from 2026-05-01, when the terminal block moved out of
 * the conception-root configuration.json into the per-machine settings.json.)
 */
export async function migrateTerminalFromConfigIfNeeded(): Promise<void> {
  // Initial read is just a fast-path bail; the authoritative check repeats
  // inside updateSettings's mutator so concurrent setTheme/setLayout IPC
  // can't race with this migration.
  const initial = await readSettings();
  if (initial.terminal && Object.keys(initial.terminal).length > 0) return;
  if (!initial.lastConceptionPath) return;
  // Legacy migration: only the original `configuration.json` is checked.
  // A fresh `condash.json` carrying a terminal block is a deliberate
  // per-conception override and stays put.
  const configFile = join(initial.lastConceptionPath, 'configuration.json');
  let raw: string;
  try {
    raw = await fs.readFile(configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const legacy = parsed.terminal as TerminalPrefs | undefined;
  if (!legacy || Object.keys(legacy).length === 0) return;
  // Atomic read-modify-write: skip the merge if cur.terminal is already
  // populated (a concurrent IPC may have written it between the initial
  // read and the queue head).
  let migrated = false;
  await updateSettings((cur) => {
    if (cur.terminal && Object.keys(cur.terminal).length > 0) return cur;
    migrated = true;
    return { ...cur, terminal: legacy };
  });
  if (!migrated) return;
  delete parsed.terminal;
  const next = JSON.stringify(parsed, null, 2) + '\n';
  await atomicWrite(configFile, next);
}
