import { CliError, ExitCodes, reportError, type OutputContext } from './output';
import { TOP_HELP } from './help';
import { parseArgs, takeUniversalFlags, UsageError } from './parser';
import { resolveConception } from './conception';

const VERSION = process.env.CONDASH_CLI_VERSION ?? 'dev';

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n${TOP_HELP}`);
      return ExitCodes.USAGE;
    }
    throw err;
  }

  let universal: ReturnType<typeof takeUniversalFlags>;
  try {
    universal = takeUniversalFlags(parsed);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n`);
      return ExitCodes.USAGE;
    }
    throw err;
  }

  // TTY-aware styling: respect the broader ecosystem signals (NO_COLOR
  // and CLICOLOR=0 from https://no-color.org / https://bixense.com), and
  // default to off when stdout isn't a TTY (pipes, file redirection,
  // CI logs). The explicit --no-color flag still wins.
  const noColor =
    universal.noColor ||
    !process.stdout.isTTY ||
    Boolean(process.env.NO_COLOR) ||
    process.env.CLICOLOR === '0';

  const ctx: OutputContext = {
    json: universal.json,
    ndjson: universal.ndjson,
    quiet: universal.quiet,
    noColor,
  };

  if (universal.version) {
    process.stdout.write(`condash ${VERSION}\n`);
    return ExitCodes.OK;
  }

  if (universal.help && !parsed.noun) {
    process.stdout.write(TOP_HELP);
    return ExitCodes.OK;
  }

  if (!parsed.noun || parsed.noun === 'help') {
    if (parsed.noun === 'help' && parsed.verb) {
      // Re-dispatch into the noun's --help path so we don't keep two help
      // strings. `condash help <noun>` → noun-level help; `condash help
      // <noun> <verb>` → verb-level help (forwards the third token as the
      // verb so the runNoun's per-verb printHelp picks it up).
      const subVerb = parsed.positional[0] ?? null;
      const subArgs = {
        ...parsed,
        noun: parsed.verb,
        verb: subVerb,
        positional: parsed.positional.slice(1),
        flags: {},
      };
      try {
        return await dispatch(subArgs, ctx, { ...universal, help: true });
      } catch (err) {
        return reportError(ctx, err);
      }
    }
    process.stdout.write(TOP_HELP);
    return ExitCodes.OK;
  }

  try {
    return await dispatch(parsed, ctx, universal);
  } catch (err) {
    return reportError(ctx, err);
  }
}

async function dispatch(
  args: ReturnType<typeof parseArgs>,
  ctx: OutputContext,
  universal: ReturnType<typeof takeUniversalFlags>,
): Promise<number> {
  // Commands that don't need conception path resolution.
  if (args.noun === 'config' && args.verb === 'conception-path') {
    const { runConfig } = await import('./commands/config');
    await runConfig(args.verb, args, ctx, '', universal.help, universal.conceptionPath);
    return ExitCodes.OK;
  }

  // `condash help <noun>` (and `--help` on any verb) must not require an
  // initialised conception. The runNoun help paths short-circuit before
  // touching the resolved path, so handing them an empty string is safe.
  // Previously `resolveConception` ran unconditionally and exited with
  // `NO_CONCEPTION` (exit 5) on a fresh machine.
  const conceptionPath = universal.help
    ? ''
    : (await resolveConception(universal.conceptionPath)).path;

  // `--help` always wins. Each runNoun honours `universalHelp` by short-
  // circuiting to per-verb help text before any required-arg check.
  const help = universal.help;

  switch (args.noun) {
    case 'projects': {
      const { runProjects } = await import('./commands/projects');
      await runProjects(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    }
    case 'knowledge': {
      const { runKnowledge } = await import('./commands/knowledge');
      await runKnowledge(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    }
    case 'search': {
      const { runSearch } = await import('./commands/search');
      await runSearch(args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    }
    case 'repos': {
      const { runRepos } = await import('./commands/repos');
      await runRepos(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    }
    case 'applications': {
      const { runApplications } = await import('./commands/applications');
      await runApplications(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    }
    case 'worktrees': {
      const { runWorktrees } = await import('./commands/worktrees');
      await runWorktrees(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    }
    case 'audit': {
      const { runAuditCommand } = await import('./commands/audit');
      await runAuditCommand(args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    }
    case 'dirty': {
      const { runDirty } = await import('./commands/dirty');
      await runDirty(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    }
    case 'logs': {
      const { runLogs } = await import('./commands/logs');
      await runLogs(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    }
    case 'skills': {
      const { runSkills } = await import('./commands/skills');
      await runSkills(args.verb, args, ctx, help);
      return ExitCodes.OK;
    }
    case 'config': {
      const { runConfig } = await import('./commands/config');
      await runConfig(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    }
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown noun: ${args.noun}`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = ExitCodes.RUNTIME;
  });
