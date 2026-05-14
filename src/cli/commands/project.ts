/**
 * `condash project build`
 *
 * Compile the conception's `AGENTS.md` source-of-truth into per-agent output
 * files (`.claude/CLAUDE.md` and `.kimi/AGENTS.md`). This is what the user
 * runs after editing `AGENTS.md` directly to refresh the compiled flavours
 * without going through `condash templates install` (which also re-syncs
 * shipped regions from condash itself).
 *
 * Same compile path as the one chained by `templates install` — this verb
 * just exposes it standalone for fast author iteration.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { AGENTS_MD_TARGETS, compileAgentsMd, type AgentsMdTarget } from '../../agents-md';
import { writeFileMkdir } from './install-shared';

const AGENTS_MD_OUTPUTS: Record<AgentsMdTarget, string> = {
  claude: '.claude/CLAUDE.md',
  kimi: '.kimi/AGENTS.md',
};

interface BuildReport {
  source: string;
  /** One entry per target, listing the absolute path written. */
  outputs: { target: AgentsMdTarget; path: string }[];
}

export async function runProject(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
): Promise<void> {
  switch (verb) {
    case 'build':
      return await buildProject(args, ctx);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown project verb: ${verb}`);
  }
}

async function buildProject(args: ParsedArgs, ctx: OutputContext): Promise<void> {
  const dest = await resolveDest(args);
  const dryRun = args.flags['dry-run'] === true;
  for (const k of ['dest', 'dry-run']) delete args.flags[k];
  assertNoExtraFlags(args);

  const sourcePath = join(dest, 'AGENTS.md');
  let source: string;
  try {
    source = await fs.readFile(sourcePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(
        ExitCodes.NOT_FOUND,
        `No AGENTS.md found at ${sourcePath}. Run \`condash templates install\` to seed it from the shipped template.`,
      );
    }
    throw err;
  }

  const report: BuildReport = { source: sourcePath, outputs: [] };
  for (const target of AGENTS_MD_TARGETS) {
    const compiled = compileAgentsMd(source, target);
    const outputPath = join(dest, AGENTS_MD_OUTPUTS[target]);
    if (!dryRun) await writeFileMkdir(outputPath, Buffer.from(compiled, 'utf8'));
    report.outputs.push({ target, path: outputPath });
  }

  emit(ctx, report, (data) => {
    const d = data as BuildReport;
    const lines = [`Source: ${d.source}`];
    for (const o of d.outputs) lines.push(`  → ${o.path}  (${o.target})`);
    return lines.join('\n') + '\n';
  });
}

async function resolveDest(args: ParsedArgs): Promise<string> {
  const explicit = args.flags.dest;
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
