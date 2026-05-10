import { listRepos } from '../../main/repos';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, type ParsedArgs } from '../parser';

export async function runRepos(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  if (verb === null || verb === 'list') {
    const includeWorktrees = args.flags['include-worktrees'] === true;
    delete args.flags['include-worktrees'];
    assertNoExtraFlags(args);
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
