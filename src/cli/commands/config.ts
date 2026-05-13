import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
  conceptionConfigWritePath,
  getEffectiveConceptionConfig,
  readConceptionConfigRaw,
  resolveConceptionConfigPath,
} from '../../main/effective-config';
import { migrateLegacyConfig } from '../../main/condash-dir-migrate';
import { settingsPath } from '../../main/settings';
import { atomicWrite } from '../../main/atomic-write';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';

export async function runConfig(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  if (verb === 'conception-path') {
    assertNoExtraFlags(args);
    const resolved = await resolveConception(undefined);
    emit(
      ctx,
      { path: resolved.path, source: resolved.source },
      (d) => `${(d as { path: string }).path}\t(${(d as { source: string }).source})\n`,
    );
    return;
  }
  if (verb === 'path') {
    assertNoExtraFlags(args);
    const conception = await resolveConceptionConfigPath(conceptionPath);
    const data = { global: settingsPath(), conception };
    emit(ctx, data, () => `global:    ${data.global}\nconception: ${data.conception}\n`);
    return;
  }
  if (verb === null || verb === 'list') {
    const useEffective = consumeFlag(args, '--effective');
    const useGlobal = consumeFlag(args, '--global');
    if (useEffective && useGlobal) {
      throw new CliError(ExitCodes.USAGE, '--effective and --global are mutually exclusive');
    }
    assertNoExtraFlags(args);
    let config: unknown;
    if (useGlobal) {
      const raw = await fs.readFile(settingsPath(), 'utf8').catch((err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
        throw err;
      });
      config = JSON.parse(raw);
    } else if (useEffective) {
      config = await getEffectiveConceptionConfig(conceptionPath);
    } else {
      // Default: per-conception view (whatever condash.json / configuration.json holds).
      config = await readConceptionConfigRaw(conceptionPath);
    }
    emit(ctx, config, () => `${JSON.stringify(config, null, 2)}\n`);
    return;
  }
  if (verb === 'get') {
    const key = args.positional[0];
    if (!key)
      throw new CliError(
        ExitCodes.USAGE,
        'Usage: condash-cli config get <key> [--effective|--global]',
      );
    const useEffective = consumeFlag(args, '--effective');
    const useGlobal = consumeFlag(args, '--global');
    if (useEffective && useGlobal) {
      throw new CliError(ExitCodes.USAGE, '--effective and --global are mutually exclusive');
    }
    assertNoExtraFlags(args);
    let config: unknown;
    let source: string;
    if (useGlobal) {
      const raw = await fs.readFile(settingsPath(), 'utf8').catch((err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
        throw err;
      });
      config = JSON.parse(raw);
      source = 'settings.json';
    } else if (useEffective) {
      config = await getEffectiveConceptionConfig(conceptionPath);
      source = 'effective';
    } else {
      config = await readConceptionConfigRaw(conceptionPath);
      source = 'condash.json';
    }
    const value = pickByDottedPath(config, key);
    if (value === undefined) {
      throw new CliError(ExitCodes.NOT_FOUND, `Key '${key}' not found in ${source}`);
    }
    emit(ctx, value, (d) => `${typeof d === 'string' ? d : JSON.stringify(d, null, 2)}\n`);
    return;
  }
  if (verb === 'set') {
    const key = args.positional[0];
    const value = args.positional[1];
    if (!key || value === undefined) {
      throw new CliError(ExitCodes.USAGE, 'Usage: condash-cli config set <key> <value> [--global]');
    }
    const writeGlobal = consumeFlag(args, '--global');
    assertNoExtraFlags(args);
    // Parse value as JSON when it looks like a primitive / object / array;
    // otherwise treat as a literal string (the common case).
    let parsedValue: unknown = value;
    const trimmed = value.trim();
    if (/^(true|false|null|-?\d|"|\[|\{)/.test(trimmed)) {
      try {
        parsedValue = JSON.parse(trimmed);
      } catch {
        parsedValue = value;
      }
    }
    if (writeGlobal) {
      await mutateJsonFile(settingsPath(), (current) => {
        setByDottedPath(current, key, parsedValue);
      });
      emit(ctx, { ok: true, target: 'settings.json', key }, () => `set ${key} in settings.json\n`);
    } else {
      const writePath = conceptionConfigWritePath(conceptionPath);
      // If the canonical primary doesn't exist yet but a legacy file does,
      // seed the new primary from the legacy content so the first `set`
      // doesn't silently drop the user's existing keys.
      const existing = await readConceptionConfigRaw(conceptionPath);
      await mutateJsonFile(writePath, (current) => {
        if (Object.keys(current).length === 0) {
          for (const [k, v] of Object.entries(existing)) current[k] = v;
        }
        setByDottedPath(current, key, parsedValue);
      });
      emit(
        ctx,
        { ok: true, target: '.condash/settings.json', key },
        () => `set ${key} in .condash/settings.json\n`,
      );
    }
    return;
  }
  if (verb === 'migrate') {
    assertNoExtraFlags(args);
    const result = await migrateLegacyConfig(conceptionPath);
    emit(ctx, result, (d) => {
      const r = d as Awaited<ReturnType<typeof migrateLegacyConfig>>;
      if (!r.migrated) {
        return r.reason === 'primary-already-exists'
          ? `already migrated — .condash/settings.json exists\n`
          : `no legacy condash.json or configuration.json found; nothing to migrate\n`;
      }
      const gi = r.gitignoreUpdated ? ' (added .condash/ to .gitignore)' : '';
      return `migrated ${r.from} → ${r.to}${gi}\n`;
    });
    return;
  }
  throw new CliError(ExitCodes.USAGE, `Unknown config verb: ${verb}`);
}

/**
 * Strip a known flag from `args.flags` (returns whether it was present).
 * Used by `runConfig` to consume `--effective` / `--global` before
 * `assertNoExtraFlags` rejects everything else.
 */
function consumeFlag(args: ParsedArgs, name: string): boolean {
  // Flag keys are stored without the leading `--`, matching the parser.
  const key = name.startsWith('--') ? name.slice(2) : name;
  const present = args.flags[key] !== undefined;
  if (present) delete args.flags[key];
  return present;
}

/** Set a value at a dotted path on `obj`, mutating in place. */
function setByDottedPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = cursor[part];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/** Read-modify-write a JSON file atomically; creates the file (and its
 * parent directory) when missing. */
async function mutateJsonFile(
  path: string,
  mutate: (current: Record<string, unknown>) => void,
): Promise<void> {
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
  mutate(current);
  // The new canonical config lives in `.condash/`, which may not exist yet
  // on a fresh conception. `atomicWrite` needs the parent dir present, so
  // mkdir -p before writing.
  await fs.mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify(current, null, 2) + '\n');
}

function pickByDottedPath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    const arrayMatch = part.match(/^([^\[]+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, name, idx] = arrayMatch;
      const next = (current as Record<string, unknown>)[name];
      if (!Array.isArray(next)) return undefined;
      current = next[Number(idx)];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}
