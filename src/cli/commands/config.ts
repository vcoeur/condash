import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
  conceptionConfigWritePath,
  getEffectiveConceptionConfig,
  readConceptionConfigRaw,
  resolveConceptionConfigPath,
} from '../../main/effective-config';
import { migrateLegacyConfig } from '../../main/condash-dir-migrate';
import { migrateRawSettings } from '../../main/config-migrate';
import { mutateSettingsJson, settingsPath } from '../../main/settings';
import { atomicWrite } from '../../main/atomic-write';
import { pickByDottedPath, setByDottedPath } from '../../shared/dotted-path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import { assertNoExtraFlags, takeBoolFlag, type ParsedArgs } from '../parser';
import { renderHelp } from '../help';

const KNOWN_FLAGS_CONCEPTION_PATH: readonly string[] = [];
const KNOWN_FLAGS_PATH: readonly string[] = [];
const KNOWN_FLAGS_LIST = ['effective', 'global'] as const;
const KNOWN_FLAGS_GET = ['effective', 'global'] as const;
const KNOWN_FLAGS_SET = ['global'] as const;
const KNOWN_FLAGS_MIGRATE: readonly string[] = [];

const NOUN_FLAGS: readonly string[] = [
  ...new Set<string>([
    ...KNOWN_FLAGS_CONCEPTION_PATH,
    ...KNOWN_FLAGS_PATH,
    ...KNOWN_FLAGS_LIST,
    ...KNOWN_FLAGS_GET,
    ...KNOWN_FLAGS_SET,
    ...KNOWN_FLAGS_MIGRATE,
  ]),
];

export async function runConfig(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
  universalHelp = false,
  universalConceptionPath?: string,
): Promise<void> {
  if (verb === 'help') {
    printHelp(args.positional[0] ?? null);
    return;
  }
  if (universalHelp) {
    printHelp(verb);
    return;
  }
  if (verb === 'conception-path') {
    assertNoExtraFlags(args, NOUN_FLAGS);
    // Honour `--conception <path>` here — the universal flag means "resolve
    // against this path", and passing it through lets `condash --conception
    // <p> config conception-path` print the same answer the rest of the
    // CLI would use for that invocation.
    const resolved = await resolveConception(universalConceptionPath);
    emit(
      ctx,
      { path: resolved.path, source: resolved.source },
      (d) => `${(d as { path: string }).path}\t(${(d as { source: string }).source})\n`,
    );
    return;
  }
  if (verb === 'path') {
    assertNoExtraFlags(args, NOUN_FLAGS);
    const conception = await resolveConceptionConfigPath(conceptionPath);
    const data = { global: settingsPath(), conception };
    emit(ctx, data, () => `global:    ${data.global}\nconception: ${data.conception}\n`);
    return;
  }
  if (verb === null || verb === 'list') {
    const useEffective = takeBoolFlag(args, 'effective');
    const useGlobal = takeBoolFlag(args, 'global');
    assertNoExtraFlags(args, NOUN_FLAGS);
    if (useEffective && useGlobal) {
      throw new CliError(ExitCodes.USAGE, '--effective and --global are mutually exclusive');
    }
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
    const useEffective = takeBoolFlag(args, 'effective');
    const useGlobal = takeBoolFlag(args, 'global');
    assertNoExtraFlags(args, NOUN_FLAGS);
    const key = args.positional[0];
    if (!key)
      throw new CliError(ExitCodes.USAGE, 'Usage: condash config get <key> [--effective|--global]');
    if (useEffective && useGlobal) {
      throw new CliError(ExitCodes.USAGE, '--effective and --global are mutually exclusive');
    }
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
      source = '.condash/settings.json';
    }
    const value = pickByDottedPath(config, key);
    if (value === undefined) {
      throw new CliError(ExitCodes.NOT_FOUND, `Key '${key}' not found in ${source}`);
    }
    emit(ctx, value, (d) => `${typeof d === 'string' ? d : JSON.stringify(d, null, 2)}\n`);
    return;
  }
  if (verb === 'set') {
    const writeGlobal = takeBoolFlag(args, 'global');
    assertNoExtraFlags(args, NOUN_FLAGS);
    const key = args.positional[0];
    const value = args.positional[1];
    if (!key || value === undefined) {
      throw new CliError(ExitCodes.USAGE, 'Usage: condash config set <key> <value> [--global]');
    }
    // Parse value as JSON only when it looks unambiguously JSON-shaped:
    // a number, a quoted string, an array, or an object. Bare `true` /
    // `false` / `null` are common string values (branch names, flag-named
    // configuration paths) — treat those as plain strings to avoid eating
    // a legitimate string assignment. Callers that genuinely want a
    // boolean / null can write `--json` (TODO) or quote it: `"true"`.
    let parsedValue: unknown = value;
    const trimmed = value.trim();
    if (/^(-?\d|"|\[|\{)/.test(trimmed)) {
      try {
        parsedValue = JSON.parse(trimmed);
      } catch {
        parsedValue = value;
      }
    }
    let written: Record<string, unknown> = {};
    if (writeGlobal) {
      // Route through the main settings writer for its atomic
      // tmp→fsync→rename and its in-process write queue. Note the queue only
      // serialises writes from *this* process — a concurrently running GUI
      // keeps its own queue, so there is no cross-process exclusion; both
      // sides writing atomically just guarantees the loser of a race leaves
      // a consistent file.
      await mutateSettingsJson((current) => {
        setByDottedPath(current, key, parsedValue);
        written = structuredClone(current);
      });
      const settingsWarnings = await schemaWarnings(written, 'settings.json');
      emit(
        ctx,
        { ok: true, target: 'settings.json', key },
        () => `set ${key} in settings.json\n`,
        settingsWarnings,
      );
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
        written = structuredClone(current);
      });
      const conceptionWarnings = await schemaWarnings(written, '.condash/settings.json');
      emit(
        ctx,
        { ok: true, target: '.condash/settings.json', key },
        () => `set ${key} in .condash/settings.json\n`,
        conceptionWarnings,
      );
    }
    return;
  }
  if (verb === 'migrate') {
    assertNoExtraFlags(args, NOUN_FLAGS);
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
 * Non-fatal write-time validation for `config set`: parse the just-written
 * config through the matching strict schema and turn each issue into a
 * warning naming the offending key. `config set` writes arbitrary dotted
 * paths by design, but the GUI's save path refuses a file the schema
 * rejects — warning here catches the typo at write time instead of bricking
 * the next Settings save.
 */
async function schemaWarnings(config: Record<string, unknown>, target: string): Promise<string[]> {
  // Lazy-load the zod schemas so the read verbs (`config get`/`list`) never
  // construct them — only `config set` reaches this write-time validation.
  const { conceptionConfigSchema, globalSettingsSchema } = await import('../../main/config-schema');
  const schema = target === 'settings.json' ? globalSettingsSchema : conceptionConfigSchema;
  // Validate a clone: migrateRawSettings mutates in place, and the legacy-key
  // stripping it does must not silently alter what was just written.
  const result = schema.safeParse(migrateRawSettings(structuredClone(config)));
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${target}: ${where} — ${issue.message}; the GUI Settings save will reject this file until it is fixed`;
  });
}

/** Read-modify-write a JSON file atomically; creates the file (and its
 * parent directory) when missing. Used for the per-conception
 * `.condash/settings.json`; the global file goes through the main settings
 * writer (`mutateSettingsJson`) to share its serialising queue. */
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

function printHelp(verb: string | null): void {
  switch (verb) {
    case 'conception-path':
      process.stdout.write(
        renderHelp([
          'condash config conception-path',
          '',
          'Print the resolved conception path + how it was resolved.',
          '',
          'Examples:',
          '  condash config conception-path',
          '  condash config conception-path --json',
        ]),
      );
      return;
    case 'path':
      process.stdout.write(
        renderHelp([
          'condash config path',
          '',
          'Print the on-disk path of the global + conception settings files.',
          '',
          'Examples:',
          '  condash config path',
        ]),
      );
      return;
    case 'list':
    case null:
      process.stdout.write(
        renderHelp([
          'condash config list [--effective|--global]',
          '',
          'Print the merged config. Default: per-conception view.',
          '',
          'Optional:',
          '  --effective   Show the merged effective config (global + conception).',
          '  --global      Show the global ~/.config/condash/settings.json only.',
          '',
          'Examples:',
          '  condash config list',
          '  condash config list --effective --json',
        ]),
      );
      return;
    case 'get':
      process.stdout.write(
        renderHelp([
          'condash config get <key> [--effective|--global]',
          '',
          'Read one config key (dotted path).',
          '',
          'Examples:',
          '  condash config get repositories[0].path',
          '  condash config get terminal.logging.enabled --effective',
        ]),
      );
      return;
    case 'set':
      process.stdout.write(
        renderHelp([
          'condash config set <key> <value> [--global]',
          '',
          'Write one config key. Value is parsed as JSON when it looks like one,',
          'otherwise treated as a literal string. Default target: .condash/settings.json.',
          '',
          'Optional:',
          '  --global   Write to ~/.config/condash/settings.json instead.',
          '',
          'Note: array-index segments (repositories[0].path) are read-only —',
          'set the whole array as a JSON value instead.',
          '',
          'Examples:',
          '  condash config set workspace_path /home/me/src',
          '  condash config set terminal.logging.retentionDays 30 --global',
        ]),
      );
      return;
    case 'migrate':
      process.stdout.write(
        renderHelp([
          'condash config migrate',
          '',
          'One-shot: copy legacy condash.json / configuration.json to .condash/settings.json',
          'and add .condash/ to .gitignore (if needed).',
          '',
          'Examples:',
          '  condash config migrate',
        ]),
      );
      return;
    default:
      printSubHelp();
  }
}

function printSubHelp(): void {
  process.stdout.write(
    renderHelp([
      'condash config <verb> [args]',
      '',
      'Verbs:',
      '  conception-path   Print the resolved conception path.',
      '  path              Print the on-disk paths of the settings files.',
      '  list              Print merged config (default: per-conception view).',
      '  get <key>         Read one config key (dotted path).',
      '  set <key> <val>   Write one config key.',
      '  migrate           Copy legacy condash.json / configuration.json to .condash/settings.json.',
    ]),
  );
}
