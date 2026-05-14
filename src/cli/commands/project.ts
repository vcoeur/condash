/**
 * `condash project build`
 *
 * Compile the conception's `.agents/agents/` source tree into per-agent
 * output files (`.claude/CLAUDE.md` and `.kimi/AGENTS.md`). This is what
 * the user runs after editing the agent-config sources directly to refresh
 * the compiled flavours without going through `condash skills install`.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import {
  AGENTS_MD_TARGETS,
  AGENTS_MD_OUTPUTS,
  compileAgentConfig,
  type AgentsMdTarget,
} from '../../agents-md';
import { writeFileMkdir } from './install-shared';

interface BuildReport {
  sourceDir: string;
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

  const sourceDir = join(dest, '.agents', 'agents');
  const commonPath = join(sourceDir, 'common.md');
  let common: string;
  try {
    common = await fs.readFile(commonPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(
        ExitCodes.NOT_FOUND,
        `No agent-config source found at ${sourceDir}. Run \`condash skills install\` to seed it from the shipped template.`,
      );
    }
    throw err;
  }

  const report: BuildReport = { sourceDir, outputs: [] };
  for (const target of AGENTS_MD_TARGETS) {
    let fragment = '';
    try {
      fragment = await fs.readFile(join(sourceDir, `${target}.md`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const compiled = compileAgentConfig(common, fragment, target);
    const outputPath = join(dest, AGENTS_MD_OUTPUTS[target]);
    if (!dryRun) await writeFileMkdir(outputPath, Buffer.from(compiled, 'utf8'));
    report.outputs.push({ target, path: outputPath });
  }

  emit(ctx, report, (data) => {
    const d = data as BuildReport;
    const lines = [`Source: ${d.sourceDir}`];
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
