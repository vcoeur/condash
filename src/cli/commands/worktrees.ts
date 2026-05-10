import { runAudit, type AuditReport } from '../../main/audit';
import {
  checkBranchState,
  setupBranchWorktrees,
  removeBranchWorktrees,
  type BranchCheckResult,
  type RemoveResult,
  type SetupResult,
} from '../../main/worktree-ops';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { assertNoExtraFlags, parseCsvFlag, type ParsedArgs } from '../parser';
import { runRepos } from './repos';

export async function runWorktrees(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  switch (verb) {
    case null:
      printWorktreesHelp();
      return;
    case 'list':
      // Full repo list with worktrees included — same payload `repos list
      // --include-worktrees` returns, kept here for the documented alias.
      args.flags['include-worktrees'] = true;
      await runRepos('list', args, ctx, conceptionPath);
      return;
    case 'check':
      return await worktreeCheck(args, ctx, conceptionPath);
    case 'mismatch':
      return await worktreeMismatch(ctx, conceptionPath);
    case 'setup':
      return await worktreeSetup(args, ctx, conceptionPath);
    case 'remove':
      return await worktreeRemove(args, ctx, conceptionPath);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown worktrees verb: ${verb}`);
  }
}

async function worktreeCheck(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const branch = args.positional[0];
  if (!branch) {
    throw new CliError(ExitCodes.USAGE, 'Usage: condash-cli worktrees check <branch>');
  }
  assertNoExtraFlags(args);
  const result = await checkBranchState(conceptionPath, branch);
  emit(ctx, result, formatBranchCheck);
}

function formatBranchCheck(result: BranchCheckResult): string {
  const lines: string[] = [];
  lines.push(`Branch: ${result.branch}`);
  lines.push(`Worktrees root: ${result.worktreesRoot}`);
  if (result.declaringItems.length === 0) {
    lines.push(`No items declare this branch.`);
  } else {
    lines.push(`Items declaring this branch (${result.declaringItems.length}):`);
    for (const i of result.declaringItems) {
      lines.push(
        `  ${i.slug}  [${i.status}]  apps: ${i.apps.length > 0 ? i.apps.join(', ') : '(none)'}`,
      );
    }
  }
  if (result.repos.length > 0) {
    lines.push(`Per-repo state:`);
    for (const r of result.repos) {
      const flags = [
        r.worktreeExists ? 'worktree✓' : 'worktree✗',
        r.localBranchExists ? 'branch✓' : 'branch✗',
        r.primaryOnBranch ? 'primary-on-branch' : '',
        r.pinnedBranch ? `pinned=${r.pinnedBranch}` : '',
      ]
        .filter(Boolean)
        .join('  ');
      lines.push(`  ${r.name}  →  ${r.expectedWorktree}  [${flags}]`);
    }
  }
  if (result.missing.length > 0) lines.push(`Missing worktrees: ${result.missing.join(', ')}`);
  if (result.orphan.length > 0) lines.push(`Orphan dirs: ${result.orphan.join(', ')}`);
  return lines.join('\n') + '\n';
}

async function worktreeMismatch(ctx: OutputContext, conceptionPath: string): Promise<void> {
  const report = await runAudit(conceptionPath, ['worktrees']);
  emit(
    ctx,
    report,
    (r) => {
      const data = r as AuditReport;
      if (data.issues.length === 0) return 'No mismatches.\n';
      const lines: string[] = [];
      for (const i of data.issues) lines.push(`${i.file ?? '-'}  ${i.message}`);
      return lines.join('\n') + '\n';
    },
    [],
    { streamField: 'issues' },
  );
}

async function worktreeSetup(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const branch = args.positional[0];
  if (!branch) {
    throw new CliError(
      ExitCodes.USAGE,
      'Usage: condash-cli worktrees setup <branch> [--repo <r>...] [--no-env] [--no-install] [--copy-env] [--base <ref>]',
    );
  }
  const repos = parseCsvFlag(args.flags.repo) ?? undefined;
  const copyEnv = args.flags['copy-env'] === true;
  const skipEnv = args.flags['no-env'] === true;
  const skipInstall = args.flags['no-install'] === true;
  if (args.flags.install === true) {
    process.stderr.write(
      '[deprecated] --install is now the default for repos that declare install: in condash.json. Use --no-install to skip.\n',
    );
  }
  const baseFlag = args.flags.base;
  const base = typeof baseFlag === 'string' && baseFlag.length > 0 ? baseFlag : undefined;
  for (const k of ['repo', 'copy-env', 'no-env', 'no-install', 'install', 'base']) {
    delete args.flags[k];
  }
  assertNoExtraFlags(args);
  const result = await setupBranchWorktrees(conceptionPath, branch, {
    repos,
    copyEnv,
    skipEnv,
    skipInstall,
    base,
  });
  emit(ctx, result, formatSetupResult);
}

function formatSetupResult(result: SetupResult): string {
  const lines: string[] = [];
  lines.push(`Setup branch: ${result.branch}`);
  if (result.base) lines.push(`Base ref: ${result.base}`);
  if (result.created.length > 0) {
    lines.push(`Created (${result.created.length}):`);
    for (const c of result.created) lines.push(`  + ${c.repo}  →  ${c.path}`);
  }
  if (result.alreadyPresent.length > 0) {
    lines.push(`Already present (${result.alreadyPresent.length}):`);
    for (const p of result.alreadyPresent) lines.push(`  · ${p.repo}  →  ${p.path}`);
  }
  if (result.envCopied.length > 0) {
    lines.push(`Env copied:`);
    for (const e of result.envCopied) lines.push(`  ${e.repo}: ${e.files.join(', ')}`);
  }
  if (result.installRan.length > 0) {
    lines.push(`Install ran:`);
    for (const r of result.installRan) {
      lines.push(`  ${r.repo}: ${r.command}  ${r.ok ? 'ok' : 'FAILED'}`);
    }
  }
  if (result.blocked.length > 0) {
    lines.push(`Blocked (${result.blocked.length}):`);
    for (const b of result.blocked) lines.push(`  ! ${b.repo}: ${b.reason}`);
  }
  return lines.join('\n') + '\n';
}

async function worktreeRemove(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const branch = args.positional[0];
  if (!branch) {
    throw new CliError(
      ExitCodes.USAGE,
      'Usage: condash-cli worktrees remove <branch> [--repo <r>...]',
    );
  }
  const repos = parseCsvFlag(args.flags.repo) ?? undefined;
  delete args.flags.repo;
  assertNoExtraFlags(args);
  const result = await removeBranchWorktrees(conceptionPath, branch, { repos });
  emit(ctx, result, formatRemoveResult);
}

function formatRemoveResult(result: RemoveResult): string {
  const lines: string[] = [];
  lines.push(`Remove branch: ${result.branch}`);
  if (result.removed.length > 0) {
    lines.push(`Removed (${result.removed.length}):`);
    for (const r of result.removed) lines.push(`  - ${r.repo}  →  ${r.path}`);
  }
  if (result.protected.length > 0) {
    lines.push(`Kept (protected, ${result.protected.length}):`);
    for (const p of result.protected) lines.push(`  · ${p.repo}: ${p.reason}`);
  }
  if (result.notPresent.length > 0) {
    lines.push(`Not present: ${result.notPresent.join(', ')}`);
  }
  if (result.parentRemoved) lines.push(`Empty parent dir removed.`);
  return lines.join('\n') + '\n';
}

function printWorktreesHelp(): void {
  process.stdout.write(
    [
      'condash-cli worktrees <verb> [args]',
      '',
      'Verbs:',
      '  list             Repos with their worktrees (alias of repos list --include-worktrees).',
      '  check <branch>   Per-repo state for one branch (declaring items, on-disk worktrees, local branches).',
      '  mismatch         Items declaring **Branch** but missing on-disk worktrees.',
      '  setup <branch>   Create worktrees for every repo in the union of **Apps** declaring this branch.',
      '                   Flags: --repo <r>... (override) --no-env --no-install --copy-env --base <ref>',
      '                   Base ref defaults to the **Base** field on declaring item READMEs (must agree).',
      '                   Repos with `env: [...]` in condash.json have those files copied by default;',
      '                   --no-env opts out. Repos with `install: <cmd>` have it run by default; --no-install',
      '                   opts out. --copy-env is the legacy opportunistic .env / .env.local copy for repos',
      '                   without `env:` declared.',
      '  remove <branch>  Remove worktrees for this branch, protected-set aware.',
      '                   Flags: --repo <r>... (override).',
      '',
    ].join('\n'),
  );
}
