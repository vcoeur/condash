import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { OpenWithSlots, OpenWithSlotKey } from '../shared/types';
import { findRepoEntry, type ConfigShape } from './config-walk';

interface RawSlot {
  label: string;
  command?: string;
  commands?: string[];
}

interface RawConfigShape extends ConfigShape {
  open_with?: Partial<Record<OpenWithSlotKey, RawSlot>>;
}

const SLOT_KEYS: readonly OpenWithSlotKey[] = ['main_ide', 'secondary_ide', 'terminal'];

async function readRawConfig(conceptionPath: string): Promise<RawConfigShape> {
  try {
    const raw = await fs.readFile(join(conceptionPath, 'configuration.json'), 'utf8');
    return JSON.parse(raw) as RawConfigShape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function canonicaliseCommand(slot: RawSlot | undefined): string | null {
  if (!slot) return null;
  if (typeof slot.command === 'string' && slot.command.trim()) return slot.command;
  if (Array.isArray(slot.commands) && slot.commands.length > 0) return slot.commands[0];
  return null;
}

export async function listOpenWith(conceptionPath: string): Promise<OpenWithSlots> {
  const config = await readRawConfig(conceptionPath);
  const out: OpenWithSlots = {};
  for (const key of SLOT_KEYS) {
    const slot = config.open_with?.[key];
    const command = canonicaliseCommand(slot);
    if (slot && command) {
      out[key] = { label: slot.label, command };
    }
  }
  return out;
}

/**
 * Tokenise a command template into argv, substituting `{path}` at the arg
 * level (no shell parsing). Quotes are honoured for tokens that contain
 * literal whitespace (e.g. `idea "{path}"`).
 */
function tokenise(command: string, path: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) tokens.push(buf);

  return tokens.map((tok) => tok.split('{path}').join(path));
}

export async function launchOpenWith(
  conceptionPath: string,
  slot: OpenWithSlotKey,
  path: string,
): Promise<void> {
  const config = await readRawConfig(conceptionPath);
  const command = canonicaliseCommand(config.open_with?.[slot]);
  if (!command) throw new Error(`open_with.${slot} is not configured`);

  const argv = tokenise(command, path);
  if (argv.length === 0) throw new Error(`open_with.${slot} command tokenises to nothing`);

  const [program, ...args] = argv;
  const child = spawn(program, args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.on('error', (err) => {
    console.error(`[launchers] ${slot} → ${program}`, err);
  });
  child.unref();
}

export async function forceStopRepo(conceptionPath: string, repoName: string): Promise<void> {
  const config = await readRawConfig(conceptionPath);
  const entry = findRepoEntry(config, repoName);
  if (!entry?.forceStop) throw new Error(`No force_stop configured for ${repoName}`);

  const child = spawn(entry.forceStop, {
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.on('error', (err) => reject(err));
    child.on('exit', () => resolve());
  });
}
