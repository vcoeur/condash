/**
 * `condash init [--path <dir>]` — bootstrap a conception tree from the
 * bundled template without launching the GUI.
 *
 * Reuses the GUI's `initConception` (the same copy the first-launch dialog
 * runs): lays down AGENTS.md (with the `{{ conception_name }}` /
 * `{{ description }}` substitutions), the shipped skills, knowledge/,
 * projects/, and a `.condash/settings.json` materialised from the shipped
 * `.example`. The template never overwrites an existing file, so a re-run
 * on an already-initialised tree creates nothing and exits 0 — the same
 * idempotence as the GUI init.
 *
 * The noun needs no resolved conception path (it creates one), so dispatch
 * handles it before `resolveConception`, like `config conception-path`.
 */
import { resolve } from 'node:path';
import { detectConceptionState, initConception } from '../../main/conception-init';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, takeStringFlag, type ParsedArgs } from '../parser';
import { renderHelp } from '../help';

const KNOWN_FLAGS_INIT = ['path'] as const;

const NOUN_FLAGS: readonly string[] = [...KNOWN_FLAGS_INIT];

export async function runInit(
  args: ParsedArgs,
  ctx: OutputContext,
  universalConceptionPath?: string,
  help = false,
): Promise<void> {
  if (args.verb === 'help') {
    printHelp();
    return;
  }
  if (help) {
    printHelp();
    return;
  }
  if (args.verb !== null) {
    throw new CliError(ExitCodes.USAGE, `Unknown init verb: ${args.verb}`);
  }
  const pathFlag = takeStringFlag(args, 'path');
  assertNoExtraFlags(args, NOUN_FLAGS);
  // Target precedence: explicit --path, then the universal --conception
  // override (init *creates* the conception it names), then the current
  // directory. A missing target directory is created by initConception.
  const target = resolve(process.cwd(), pathFlag ?? universalConceptionPath ?? '.');
  const state = await detectConceptionState(target);
  const created = await initConception(target);

  emit(ctx, { path: target, created }, (d) =>
    formatInitHuman(d as { path: string; created: string[] }, state.looksInitialised),
  );
}

function formatInitHuman(
  data: { path: string; created: string[] },
  alreadyInitialised: boolean,
): string {
  const { path, created } = data;
  if (created.length === 0) {
    return alreadyInitialised
      ? `Already initialised — ${path} looks like a conception (projects/ + a config file present).\nExisting files are never overwritten; nothing to create.\n`
      : `Nothing to create at ${path} — existing files are never overwritten.\n`;
  }
  const files = created.map((rel) => `${rel}\n`).join('');
  const preserved = alreadyInitialised ? ' Existing files were left untouched.' : '';
  return `${files}Initialised conception at ${path} — ${created.length} files created.${preserved}\n`;
}

function printHelp(): void {
  process.stdout.write(
    renderHelp([
      'condash init [--path <dir>]',
      '',
      'Bootstrap a conception tree from the bundled template: AGENTS.md',
      '(with the name/description tokens filled in), the shipped skills,',
      'knowledge/, projects/, and a .condash/settings.json materialised from',
      'the shipped .example. Without --path, initialises the current directory.',
      '',
      'Existing files are never overwritten — re-running on an already-',
      'initialised tree creates nothing and exits 0.',
      '',
      'Optional:',
      '  --path <dir>  Directory to initialise (created if missing).',
      '                Default: the current directory.',
      '',
      'Examples:',
      '  condash init',
      '  condash init --path ~/conception',
    ]),
  );
}
