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
import { renderHelp, runNoun } from '../help';
import { runRepos } from './repos';

const KNOWN_FLAGS_LIST = ['include-worktrees'] as const;
const KNOWN_FLAGS_CHECK: readonly string[] = [];
const KNOWN_FLAGS_MISMATCH: readonly string[] = [];
const KNOWN_FLAGS_SETUP = ['repo', 'copy-env', 'no-env', 'no-install', 'install', 'base'] as const;
const KNOWN_FLAGS_REMOVE = ['repo', 'force', 'force-rm'] as const;

const NOUN_FLAGS: readonly string[] = [
  ...new Set<string>([
    ...KNOWN_FLAGS_LIST,
    ...KNOWN_FLAGS_CHECK,
    ...KNOWN_FLAGS_MISMATCH,
    ...KNOWN_FLAGS_SETUP,
    ...KNOWN_FLAGS_REMOVE,
  ]),
];

export async function runWorktrees(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
  universalHelp = false,
): Promise<void> {
  await runNoun(
    'worktrees',
    verb,
    args,
    {
      list: () => {
        // Full repo list with worktrees included — same payload `repos list
        // --include-worktrees` returns, kept here for the documented alias.
        args.flags['include-worktrees'] = true;
        return runRepos('list', args, ctx, conceptionPath);
      },
      check: () => worktreeCheck(args, ctx, conceptionPath),
      mismatch: () => worktreeMismatch(args, ctx, conceptionPath),
      setup: () => worktreeSetup(args, ctx, conceptionPath),
      remove: () => worktreeRemove(args, ctx, conceptionPath),
    },
    printHelp,
    universalHelp,
  );
}

async function worktreeCheck(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  assertNoExtraFlags(args, NOUN_FLAGS);
  const branch = args.positional[0];
  if (!branch) {
    throw new CliError(ExitCodes.USAGE, 'Usage: condash worktrees check <branch>');
  }
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

async function worktreeMismatch(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  assertNoExtraFlags(args, NOUN_FLAGS);
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
  const repos = parseCsvFlag(args.flags.repo) ?? undefined;
  const copyEnv = args.flags['copy-env'] === true;
  const skipEnv = args.flags['no-env'] === true;
  const skipInstall = args.flags['no-install'] === true;
  const installDeprecated = args.flags.install === true;
  const baseFlag = args.flags.base;
  const base = typeof baseFlag === 'string' && baseFlag.length > 0 ? baseFlag : undefined;
  for (const k of ['repo', 'copy-env', 'no-env', 'no-install', 'install', 'base']) {
    delete args.flags[k];
  }
  assertNoExtraFlags(args, NOUN_FLAGS);
  if (installDeprecated && !ctx.quiet) {
    process.stderr.write(
      '[deprecated] --install is now the default for repos that declare install: in .condash/settings.json. Use --no-install to skip.\n',
    );
  }
  const branch = args.positional[0];
  if (!branch) {
    throw new CliError(
      ExitCodes.USAGE,
      'Usage: condash worktrees setup <branch> [--repo <r>...] [--no-env] [--no-install] [--copy-env] [--base <ref>]',
    );
  }
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
  const repos = parseCsvFlag(args.flags.repo) ?? undefined;
  const force = args.flags.force === true;
  const forceRm = args.flags['force-rm'] === true;
  for (const k of ['repo', 'force', 'force-rm']) delete args.flags[k];
  assertNoExtraFlags(args, NOUN_FLAGS);
  const branch = args.positional[0];
  if (!branch) {
    throw new CliError(
      ExitCodes.USAGE,
      'Usage: condash worktrees remove <branch> [--repo <r>...] [--force] [--force-rm]',
    );
  }
  const result = await removeBranchWorktrees(conceptionPath, branch, { repos, force, forceRm });
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
  if (result.partiallyRemoved.length > 0) {
    lines.push(`Partially removed (${result.partiallyRemoved.length}):`);
    for (const p of result.partiallyRemoved) {
      lines.push(`  ! ${p.repo}  →  ${p.path}`);
      lines.push(`      ${p.reason}`);
    }
    lines.push(`  Re-run with --force-rm to delete the leftover directories.`);
  }
  if (result.notPresent.length > 0) {
    lines.push(`Not present: ${result.notPresent.join(', ')}`);
  }
  if (result.parentRemoved) lines.push(`Empty parent dir removed.`);
  return lines.join('\n') + '\n';
}

function printHelp(verb: string | null): void {
  switch (verb) {
    case 'list':
      process.stdout.write(
        renderHelp([
          'condash worktrees list',
          '',
          'List configured repos with their worktrees (alias of `repos list --include-worktrees`).',
          '',
          'Examples:',
          '  condash worktrees list',
          '  condash worktrees list --json',
        ]),
      );
      return;
    case 'check':
      process.stdout.write(
        renderHelp([
          'condash worktrees check <branch>',
          '',
          'Per-repo state for one branch: declaring items, on-disk worktrees, local branches.',
          '',
          'Examples:',
          '  condash worktrees check condash-cli-ux-fixes',
        ]),
      );
      return;
    case 'mismatch':
      process.stdout.write(
        renderHelp([
          'condash worktrees mismatch',
          '',
          'List items declaring **Branch** but missing on-disk worktrees.',
          '',
          'Examples:',
          '  condash worktrees mismatch',
          '  condash worktrees mismatch --json',
        ]),
      );
      return;
    case 'setup':
      process.stdout.write(
        renderHelp([
          'condash worktrees setup <branch> [--repo <r>...] [--no-env] [--no-install] [--copy-env] [--base <ref>]',
          '',
          'Create worktrees for every repo in the union of **Apps** declaring this branch.',
          '',
          'Optional:',
          '  --repo         Restrict to specific repos (comma-separated).',
          '  --no-env       Skip the per-repo env-file copy declared in .condash/settings.json.',
          '  --no-install   Skip the per-repo install command declared in .condash/settings.json.',
          '  --copy-env     Legacy: opportunistic .env / .env.local copy for repos without `env:`.',
          '  --base         Base ref. Defaults to **Base** from declaring item READMEs (must agree).',
          '',
          'Examples:',
          '  condash worktrees setup condash-cli-ux-fixes',
          '  condash worktrees setup feature-x --repo condash --no-install',
        ]),
      );
      return;
    case 'remove':
      process.stdout.write(
        renderHelp([
          'condash worktrees remove <branch> [--repo <r>...] [--force] [--force-rm]',
          '',
          'Remove worktrees for this branch, protected-set aware.',
          '',
          'Optional:',
          '  --repo       Restrict to specific repos (comma-separated).',
          '  --force      Pass through to `git worktree remove --force` (deletes even if dirty).',
          '  --force-rm   Implies --force; if git deregisters but leaves files behind, `rm -rf` them.',
          '',
          'Examples:',
          '  condash worktrees remove condash-cli-ux-fixes',
          '  condash worktrees remove feature-x --force-rm',
        ]),
      );
      return;
    default:
      printSubHelp();
  }
}

function printSubHelp(): void {
  process.stdout.write(
    renderHelp([
      'condash worktrees <verb> [args]',
      '',
      'Verbs:',
      '  list             Repos with their worktrees (alias of `repos list --include-worktrees`).',
      '  check <branch>   Per-repo state for one branch.',
      '  mismatch         Items declaring **Branch** but missing on-disk worktrees.',
      '  setup <branch>   Create worktrees for every repo declaring this branch.',
      '  remove <branch>  Remove worktrees for this branch, protected-set aware.',
    ]),
  );
}
