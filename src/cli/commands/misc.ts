import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { search as searchAll } from '../../main/search';
import { listRepos } from '../../main/repos';
import { runAudit, type AuditCheckName, type AuditReport } from '../../main/audit';
import {
  conceptionConfigWritePath,
  getEffectiveConceptionConfig,
  readConceptionConfigRaw,
  resolveConceptionConfigPath,
} from '../../main/effective-config';
import { settingsPath } from '../../main/settings';
import { atomicWrite } from '../../main/atomic-write';
import {
  checkBranchState,
  setupBranchWorktrees,
  removeBranchWorktrees,
  type BranchCheckResult,
  type RemoveResult,
  type SetupResult,
} from '../../main/worktree-ops';
import { touchDirtyMarker } from '../../main/dirty';
import { CliError, ExitCodes, emit, type OutputContext } from '../output';
import { resolveConception } from '../conception';
import { assertNoExtraFlags, parseCsvFlag, parseIntFlag, type ParsedArgs } from '../parser';

const ALL_AUDIT_CHECKS: AuditCheckName[] = ['lfs', 'binaries', 'cross-repo', 'worktrees', 'index'];

export async function runSearch(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const query = args.positional.join(' ').trim();
  if (!query) throw new CliError(ExitCodes.USAGE, 'Usage: condash-cli search <query>');
  const scope = (args.flags.scope as string | undefined) ?? 'all';
  if (!['all', 'projects', 'knowledge'].includes(scope)) {
    throw new CliError(ExitCodes.USAGE, '--scope must be all|projects|knowledge');
  }
  const limit = parseIntFlag(args.flags.limit, 50);
  for (const k of ['scope', 'limit']) delete args.flags[k];
  assertNoExtraFlags(args);

  const results = await searchAll(conceptionPath, query);
  const filtered = scope === 'all' ? results.hits : results.hits.filter((h) => h.source === scope);

  emit(
    ctx,
    {
      query,
      scope,
      hits: filtered.slice(0, limit),
      totalBeforeFilter: results.totalBeforeCap,
      truncated: results.truncated,
      terms: results.terms,
    },
    (d) => {
      const data = d as { hits: typeof filtered };
      if (data.hits.length === 0) return `(no matches for "${query}")\n`;
      return (
        data.hits
          .map((h) => `${h.relPath}: ${h.snippets[0]?.text.slice(0, 120) ?? ''}`)
          .join('\n') + '\n'
      );
    },
    [],
    { streamField: 'hits' },
  );
}

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
      '[deprecated] --install is now the default for repos that declare install: in configuration.json. Use --no-install to skip.\n',
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
      '                   Repos with `env: [...]` in configuration.json have those files copied by default;',
      '                   --no-env opts out. Repos with `install: <cmd>` have it run by default; --no-install',
      '                   opts out. --copy-env is the legacy opportunistic .env / .env.local copy for repos',
      '                   without `env:` declared.',
      '  remove <branch>  Remove worktrees for this branch, protected-set aware.',
      '                   Flags: --repo <r>... (override).',
      '',
    ].join('\n'),
  );
}

export async function runAuditCommand(
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  const include =
    typeof args.flags.include === 'string'
      ? args.flags.include
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : ALL_AUDIT_CHECKS;
  for (const c of include) {
    if (!ALL_AUDIT_CHECKS.includes(c as AuditCheckName)) {
      throw new CliError(
        ExitCodes.USAGE,
        `--include must be a comma-separated subset of {${ALL_AUDIT_CHECKS.join(', ')}}; got '${c}'`,
      );
    }
  }
  delete args.flags.include;
  assertNoExtraFlags(args);
  const report = await runAudit(conceptionPath, include as AuditCheckName[]);
  emit(ctx, report, formatAuditPretty, [], { streamField: 'issues' });
}

function formatAuditPretty(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`=== conception audit ===`);
  lines.push(`Root:         ${report.summary.conceptionRoot}`);
  lines.push(`Checks run:   ${report.summary.checksRun.join(', ')}`);
  lines.push(`Total:        ${report.summary.total} issues`);
  lines.push(`Severity:     ${JSON.stringify(report.summary.bySeverity)}`);
  lines.push(`By check:     ${JSON.stringify(report.summary.byCheck)}`);
  lines.push('');
  if (report.issues.length === 0) {
    lines.push('No issues found.');
    return lines.join('\n') + '\n';
  }
  for (const i of report.issues) {
    const loc = i.line ? `${i.file ?? '-'}:${i.line}` : (i.file ?? '-');
    lines.push(`[${i.severity.padEnd(5)}] ${i.check.padEnd(12)} ${loc}`);
    lines.push(`        ${i.message}`);
  }
  return lines.join('\n') + '\n';
}

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

export async function runDirty(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  if (verb === null || verb === 'list') {
    assertNoExtraFlags(args);
    const data = {
      projects: await readMarker(join(conceptionPath, 'projects', '.index-dirty')),
      knowledge: await readMarker(join(conceptionPath, 'knowledge', '.index-dirty')),
    };
    emit(ctx, data, (d) => {
      const x = d as typeof data;
      const lines: string[] = [];
      lines.push(
        `projects:  ${x.projects.present ? `dirty (since ${x.projects.mtime})` : 'clean'}`,
      );
      lines.push(
        `knowledge: ${x.knowledge.present ? `dirty (since ${x.knowledge.mtime})` : 'clean'}`,
      );
      return lines.join('\n') + '\n';
    });
    return;
  }
  if (verb === 'touch') {
    const tree = args.positional[0];
    if (tree !== 'projects' && tree !== 'knowledge') {
      throw new CliError(ExitCodes.USAGE, 'Usage: condash-cli dirty touch <projects|knowledge>');
    }
    assertNoExtraFlags(args);
    await touchDirtyMarker(conceptionPath, tree);
    const path = join(conceptionPath, tree, '.index-dirty');
    emit(ctx, { tree, path, present: true }, (d) => `touched ${(d as { path: string }).path}\n`);
    return;
  }
  if (verb === 'clear') {
    const which = args.positional[0];
    if (which !== 'projects' && which !== 'knowledge' && which !== 'all') {
      throw new CliError(
        ExitCodes.USAGE,
        'Usage: condash-cli dirty clear <projects|knowledge|all>',
      );
    }
    assertNoExtraFlags(args);
    const targets = which === 'all' ? ['projects', 'knowledge'] : [which];
    const cleared: string[] = [];
    for (const t of targets) {
      const path = join(conceptionPath, t, '.index-dirty');
      try {
        await fs.unlink(path);
        cleared.push(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    emit(
      ctx,
      { cleared },
      (d) => {
        const list = (d as { cleared: string[] }).cleared;
        return list.length === 0
          ? '(no markers were present)\n'
          : list.map((p) => `cleared ${p}`).join('\n') + '\n';
      },
      [],
      { streamField: 'cleared' },
    );
    return;
  }
  throw new CliError(ExitCodes.USAGE, `Unknown dirty verb: ${verb}`);
}

export async function runConfig(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
): Promise<void> {
  if (verb === 'conception-path') {
    assertNoExtraFlags(args);
    const resolved = await resolveConception(undefined);
    emit(
      ctx,
      { path: resolved.path, source: resolved.source },
      (d) => `${(d as { path: string }).path}\t(${(d as { source: string }).source})\n`,
    );
    return;
  }
  if (verb === 'path') {
    assertNoExtraFlags(args);
    const conception = await resolveConceptionConfigPath(conceptionPath);
    const data = { global: settingsPath(), conception };
    emit(ctx, data, () => `global:    ${data.global}\nconception: ${data.conception}\n`);
    return;
  }
  if (verb === null || verb === 'list') {
    const useEffective = consumeFlag(args, '--effective');
    const useGlobal = consumeFlag(args, '--global');
    if (useEffective && useGlobal) {
      throw new CliError(ExitCodes.USAGE, '--effective and --global are mutually exclusive');
    }
    assertNoExtraFlags(args);
    let config: unknown;
    if (useGlobal) {
      const raw = await fs.readFile(settingsPath(), 'utf8').catch((err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
        throw err;
      });
      config = JSON.parse(raw);
    } else if (useEffective) {
      config = await getEffectiveConceptionConfig(conceptionPath);
    } else {
      // Default: per-conception view (whatever condash.json / configuration.json holds).
      config = await readConceptionConfigRaw(conceptionPath);
    }
    emit(ctx, config, () => `${JSON.stringify(config, null, 2)}\n`);
    return;
  }
  if (verb === 'get') {
    const key = args.positional[0];
    if (!key)
      throw new CliError(
        ExitCodes.USAGE,
        'Usage: condash-cli config get <key> [--effective|--global]',
      );
    const useEffective = consumeFlag(args, '--effective');
    const useGlobal = consumeFlag(args, '--global');
    if (useEffective && useGlobal) {
      throw new CliError(ExitCodes.USAGE, '--effective and --global are mutually exclusive');
    }
    assertNoExtraFlags(args);
    let config: unknown;
    let source: string;
    if (useGlobal) {
      const raw = await fs.readFile(settingsPath(), 'utf8').catch((err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
        throw err;
      });
      config = JSON.parse(raw);
      source = 'settings.json';
    } else if (useEffective) {
      config = await getEffectiveConceptionConfig(conceptionPath);
      source = 'effective';
    } else {
      config = await readConceptionConfigRaw(conceptionPath);
      source = 'condash.json';
    }
    const value = pickByDottedPath(config, key);
    if (value === undefined) {
      throw new CliError(ExitCodes.NOT_FOUND, `Key '${key}' not found in ${source}`);
    }
    emit(ctx, value, (d) => `${typeof d === 'string' ? d : JSON.stringify(d, null, 2)}\n`);
    return;
  }
  if (verb === 'set') {
    const key = args.positional[0];
    const value = args.positional[1];
    if (!key || value === undefined) {
      throw new CliError(ExitCodes.USAGE, 'Usage: condash-cli config set <key> <value> [--global]');
    }
    const writeGlobal = consumeFlag(args, '--global');
    assertNoExtraFlags(args);
    // Parse value as JSON when it looks like a primitive / object / array;
    // otherwise treat as a literal string (the common case).
    let parsedValue: unknown = value;
    const trimmed = value.trim();
    if (/^(true|false|null|-?\d|"|\[|\{)/.test(trimmed)) {
      try {
        parsedValue = JSON.parse(trimmed);
      } catch {
        parsedValue = value;
      }
    }
    if (writeGlobal) {
      await mutateJsonFile(settingsPath(), (current) => {
        setByDottedPath(current, key, parsedValue);
      });
      emit(ctx, { ok: true, target: 'settings.json', key }, () => `set ${key} in settings.json\n`);
    } else {
      const writePath = conceptionConfigWritePath(conceptionPath);
      // If condash.json doesn't exist yet but configuration.json does,
      // seed condash.json from the legacy file so the first set doesn't
      // silently drop the user's existing keys.
      const existing = await readConceptionConfigRaw(conceptionPath);
      await mutateJsonFile(writePath, (current) => {
        if (Object.keys(current).length === 0) {
          for (const [k, v] of Object.entries(existing)) current[k] = v;
        }
        setByDottedPath(current, key, parsedValue);
      });
      emit(ctx, { ok: true, target: 'condash.json', key }, () => `set ${key} in condash.json\n`);
    }
    return;
  }
  throw new CliError(ExitCodes.USAGE, `Unknown config verb: ${verb}`);
}

/**
 * Strip a known flag from `args.flags` (returns whether it was present).
 * Used by `runConfig` to consume `--effective` / `--global` before
 * `assertNoExtraFlags` rejects everything else.
 */
function consumeFlag(args: ParsedArgs, name: string): boolean {
  // Flag keys are stored without the leading `--`, matching the parser.
  const key = name.startsWith('--') ? name.slice(2) : name;
  const present = args.flags[key] !== undefined;
  if (present) delete args.flags[key];
  return present;
}

/** Set a value at a dotted path on `obj`, mutating in place. */
function setByDottedPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = cursor[part];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/** Read-modify-write a JSON file atomically; creates the file when missing. */
async function mutateJsonFile(
  path: string,
  mutate: (current: Record<string, unknown>) => void,
): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  mutate(current);
  await atomicWrite(path, JSON.stringify(current, null, 2) + '\n');
}

function pickByDottedPath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    const arrayMatch = part.match(/^([^\[]+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, name, idx] = arrayMatch;
      const next = (current as Record<string, unknown>)[name];
      if (!Array.isArray(next)) return undefined;
      current = next[Number(idx)];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

interface MarkerInfo {
  present: boolean;
  mtime: string | null;
}

async function readMarker(path: string): Promise<MarkerInfo> {
  try {
    const stat = await fs.stat(path);
    return { present: true, mtime: stat.mtime.toISOString() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { present: false, mtime: null };
    }
    throw err;
  }
}
