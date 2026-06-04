import { listRepos } from '../../main/repos';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';
import { renderHelp } from '../help';

const KNOWN_FLAGS_LIST = ['include-worktrees'] as const;

const NOUN_FLAGS: readonly string[] = [...new Set<string>([...KNOWN_FLAGS_LIST])];

export async function runRepos(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
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
  if (verb === null || verb === 'list') {
    const includeWorktrees = args.flags['include-worktrees'] === true;
    delete args.flags['include-worktrees'];
    assertNoExtraFlags(args, NOUN_FLAGS);
    const repos = await listRepos(conceptionPath);
    if (!includeWorktrees) {
      // Strip worktrees to match the documented default (faster, no per-repo
      // git status shell-out beyond what listRepos already paid for).
      for (const r of repos) delete r.worktrees;
    }
    emit(ctx, repos, (d) => {
      const data = d as typeof repos;
      if (data.length === 0) return '(no repos configured)\n';
      return (
        data.map((r) => `${r.name.padEnd(24)}  ${r.missing ? '(missing)' : r.path}`).join('\n') +
        '\n'
      );
    });
    return;
  }
  throw new CliError(ExitCodes.USAGE, `Unknown repos verb: ${verb}`);
}

function printHelp(verb: string | null): void {
  if (verb === 'list' || verb === null) {
    process.stdout.write(
      renderHelp([
        'condash repos list [--include-worktrees]',
        '',
        'List configured repositories from condash.json.',
        '',
        'Optional:',
        "  --include-worktrees   Also report each repo's worktrees (slower).",
        '',
        'Examples:',
        '  condash repos list',
        '  condash repos list --include-worktrees --json',
      ]),
    );
    return;
  }
  printSubHelp();
}

function printSubHelp(): void {
  process.stdout.write(
    renderHelp([
      'condash repos <verb> [args]',
      '',
      'Verbs:',
      '  list   List configured repositories.',
    ]),
  );
}
