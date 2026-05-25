/**
 * `condash project build`
 *
 * Compile the conception's `.agents/agents/` source tree into per-agent
 * output files (`.claude/CLAUDE.md` and `.kimi/AGENTS.md`). This is what
 * the user runs after editing the agent-config sources directly to refresh
 * the compiled flavours without going through `condash skills install`.
 */

import { isAbsolute, join, resolve } from 'node:path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { UNIVERSAL_FOOTER } from '../help';
import type { AgentsMdTarget } from '../../agents-md';
import { compileAgentConfigs } from './files';

const KNOWN_FLAGS_BUILD = ['dest', 'dry-run'] as const;

const NOUN_FLAGS: readonly string[] = [...new Set<string>([...KNOWN_FLAGS_BUILD])];

interface BuildReport {
  sourceDir: string;
  /** One entry per target, listing the absolute path written. */
  outputs: { target: AgentsMdTarget; path: string }[];
}

export async function runProject(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  universalHelp = false,
): Promise<void> {
  if (verb === 'help') {
    printHelp(args.positional[0] ?? null);
    return;
  }
  if (universalHelp) {
    printHelp(verb);
    return;
  }
  switch (verb) {
    case 'build':
      return await buildProject(args, ctx);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown project verb: ${verb}`);
  }
}

async function buildProject(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const dryRun = args.flags['dry-run'] === true;
  // `dest` is read inside resolveDest; stash + clear before assertNoExtraFlags.
  const destFlag = args.flags.dest;
  for (const k of ['dest', 'dry-run']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);
  const dest = await resolveDest(destFlag);

  const sourceDir = join(dest, '.agents', 'agents');
  // Delegate to the same split-aware compile as `condash skills install`:
  // reads condash.md + conception.md (or splits a legacy common.md) and
  // injects the per-conception preamble variables.
  const written = await compileAgentConfigs(dest, dryRun);
  if (written.length === 0) {
    throw new CliError(
      ExitCodes.NOT_FOUND,
      `No agent-config source found at ${sourceDir}. Run \`condash skills install\` to seed it from the shipped template.`,
    );
  }

  const report: BuildReport = {
    sourceDir,
    outputs: written.map((w) => ({ target: w.target, path: join(dest, w.path) })),
  };

  emit(ctx, report, (data) => {
    const d = data as BuildReport;
    const lines = [`Source: ${d.sourceDir}`];
    for (const o of d.outputs) lines.push(`  → ${o.path}  (${o.target})`);
    return lines.join('\n') + '\n';
  });
}

async function resolveDest(explicit: string | boolean | undefined): Promise<string> {
  if (typeof explicit === 'string') {
    return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  }
  try {
    const resolved = await resolveConception(undefined);
    return resolved.path;
  } catch {
    return process.cwd();
  }
}

function printHelp(verb: string | null): void {
  if (verb === 'build' || verb === null) {
    process.stdout.write(
      [
        'condash project build [--dest <path>] [--dry-run]',
        '',
        "Compile the conception's `.agents/agents/` source tree into per-agent",
        'output files (`.claude/CLAUDE.md` and `.kimi/AGENTS.md`).',
        '',
        'Optional:',
        '  --dest      Conception root to build (default: resolved conception or cwd).',
        '  --dry-run   Show what would be written without modifying anything.',
        '',
        'Examples:',
        '  condash project build',
        '  condash project build --dest ~/src/vcoeur/conception --dry-run',
        '',
        UNIVERSAL_FOOTER,
        '',
      ].join('\n'),
    );
    return;
  }
  printSubHelp();
}

function printSubHelp(): void {
  process.stdout.write(
    [
      'condash project <verb> [args]',
      '',
      'Verbs:',
      '  build   Compile .agents/agents/ → .claude/CLAUDE.md + .kimi/AGENTS.md.',
      '',
      UNIVERSAL_FOOTER,
      '',
    ].join('\n'),
  );
}
