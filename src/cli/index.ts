import { CliError, ExitCodes, reportError, type OutputContext } from './output';
import { parseArgs, takeUniversalFlags, UsageError } from './parser';
import { resolveConception } from './conception';
import { runProjects } from './commands/projects';
import { runKnowledge } from './commands/knowledge';
import { runSearch } from './commands/search';
import { runRepos } from './commands/repos';
import { runApplications } from './commands/applications';
import { runWorktrees } from './commands/worktrees';
import { runAuditCommand } from './commands/audit';
import { runDirty } from './commands/dirty';
import { runConfig } from './commands/config';
import { runSkills } from './commands/skills';

const VERSION = process.env.CONDASH_CLI_VERSION ?? 'dev';

const TOP_HELP = `condash <noun> <verb> [args] [--flags]

GUI:
  condash                       Launch the dashboard.
  condash gui [chromium-switch] Launch with Chromium switches (debugging).

Nouns:
  projects     list, read, resolve, search, validate, status get|set, close,
               reopen, backfill-closed, index, create, scan-promotions
  knowledge    tree, verify, retrieve, stamp, index
  search       cross-tree search (--scope all|projects|knowledge)
  repos        list configured repositories
  applications list, add, set, rename, sync-docs, validate (the #handle registry)
  worktrees    list, check <branch>, mismatch, setup <branch>, remove <branch>
  audit        umbrella audit (--include lfs,binaries,cross-repo,worktrees,index)
  dirty        list, touch <tree>, clear <tree|all>
  skills       list shipped artefacts; install [<name-or-path>...]; status; validate
  config       conception-path, path, list [--effective|--global],
               get <key> [--effective|--global], set <key> <value> [--global],
               migrate (legacy condash.json → .condash/settings.json)
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
    case 'projects':
      await runProjects(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    case 'knowledge':
      await runKnowledge(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    case 'search':
      await runSearch(args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    case 'repos':
      await runRepos(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    case 'applications':
      await runApplications(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    case 'worktrees':
      await runWorktrees(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    case 'audit':
      await runAuditCommand(args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    case 'dirty':
      await runDirty(args.verb, args, ctx, conceptionPath, help);
      return ExitCodes.OK;
    case 'skills':
      await runSkills(args.verb, args, ctx, help);
      return ExitCodes.OK;
    case 'config':
      await runConfig(args.verb, args, ctx, conceptionPath, help);
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
