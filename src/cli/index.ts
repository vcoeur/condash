import { CliError, ExitCodes, reportError, type OutputContext } from './output';
import { parseArgs, takeUniversalFlags, UsageError } from './parser';
import { resolveConception } from './conception';
import { runProjects } from './commands/projects';
import { runKnowledge } from './commands/knowledge';
import { runConfig, runDirty, runRepos, runSearch } from './commands/misc';
import { runSkills } from './commands/skills';

const VERSION = process.env.CONDASH_CLI_VERSION ?? 'dev';

const TOP_HELP = `condash <noun> <verb> [args] [--flags]

Nouns:
  projects     list, read, resolve, search, validate, status get|set, close
  knowledge    tree, verify, retrieve, stamp
  search       cross-tree search (--scope all|projects|knowledge)
  repos        list configured repositories
  worktrees    list (alias of: repos list --include-worktrees, filtered)
  dirty        list, touch <tree>, clear <tree|all>
  skills       list shipped skills; install [<name>...]; status
  config       conception-path, list, get <key>
  help         this message; or 'condash help <noun>' for verbs

Universal flags:
  --conception <path>   Override conception root.
  --json                Emit a single JSON envelope on stdout.
  --ndjson              Emit one JSON object per line.
  --quiet, -q           Suppress diagnostics on stderr.
  --no-color            Disable ANSI styling.
  -h, --help            Show help.
  -v, --version         Show version.

Exit codes:
  0 ok    1 runtime    2 usage    3 validation
  4 not-found    5 no-conception    6 ambiguous
`;

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

  const ctx: OutputContext = {
    json: universal.json,
    ndjson: universal.ndjson,
    quiet: universal.quiet,
    noColor: universal.noColor || !process.stdout.isTTY,
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
      // Re-dispatch into the noun's --help path so we don't keep two help strings.
      const subArgs = {
        ...parsed,
        noun: parsed.verb,
        verb: null,
        positional: [],
        flags: { help: true },
      };
      try {
        return await dispatch(subArgs, ctx, universal);
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
    await runConfig(args.verb, args, ctx, '');
    return ExitCodes.OK;
  }

  const resolved = await resolveConception(universal.conceptionPath);
  const conceptionPath = resolved.path;

  switch (args.noun) {
    case 'projects':
      await runProjects(args.verb, args, ctx, conceptionPath);
      return ExitCodes.OK;
    case 'knowledge':
      await runKnowledge(args.verb, args, ctx, conceptionPath);
      return ExitCodes.OK;
    case 'search':
      await runSearch(args, ctx, conceptionPath);
      return ExitCodes.OK;
    case 'repos':
      await runRepos(args.verb, args, ctx, conceptionPath);
      return ExitCodes.OK;
    case 'worktrees':
      // Alias: project list filtered by branch. For now, route to repos list
      // with --include-worktrees so the user gets something useful; richer
      // surface is a follow-up.
      args.flags['include-worktrees'] = true;
      await runRepos('list', args, ctx, conceptionPath);
      return ExitCodes.OK;
    case 'dirty':
      await runDirty(args.verb, args, ctx, conceptionPath);
      return ExitCodes.OK;
    case 'skills':
      await runSkills(args.verb, args, ctx);
      return ExitCodes.OK;
    case 'config':
      await runConfig(args.verb, args, ctx, conceptionPath);
      return ExitCodes.OK;
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
