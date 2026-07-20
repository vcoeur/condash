/**
 * Issue #168: `condash worktrees setup` used to refuse any branch name
 * containing `/`, locking out the standard `feature/x` / `chore/x` patterns.
 * The setup mutator now flattens slashes to `-` for the on-disk directory
 * key while leaving the actual git ref intact.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec as execFile } from '../exec';
import { isSafeRelativePath, resolveBase, setupBranchWorktrees } from './setup';
import { removeBranchWorktrees } from './remove';
import { checkBranchState } from './inspect';
import { branchToDir, validateBranchName } from './shared';

let prevXdgConfigHome: string | undefined;
let xdgHome: string;

let tmp: string;
let conception: string;
let repo: string;
let worktreesRoot: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  return stdout;
}

beforeAll(() => {
  prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
  xdgHome = mkdtempSync(join(tmpdir(), 'condash-xdg-'));
  process.env.XDG_CONFIG_HOME = xdgHome;
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-setup-'));
  conception = join(tmp, 'conception');
  repo = join(tmp, 'workspace', 'demo');
  worktreesRoot = join(tmp, 'wt');
  mkdirSync(conception, { recursive: true });
  mkdirSync(join(tmp, 'workspace'), { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  writeFileSync(
    join(conception, 'condash.json'),
    JSON.stringify(
      {
        workspace_path: join(tmp, 'workspace'),
        worktrees_path: worktreesRoot,
        repositories: [{ name: 'demo' }],
      },
      null,
      2,
    ),
  );
  await git(join(tmp, 'workspace'), 'init', '-q', '-b', 'main', 'demo');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
});

describe('branchToDir / validateBranchName', () => {
  it('flattens slashes for the on-disk directory key', () => {
    expect(branchToDir('feature/some-work')).toBe('feature-some-work');
    expect(branchToDir('chore/x/y')).toBe('chore-x-y');
    expect(branchToDir('plain')).toBe('plain');
  });

  it('accepts namespaced branch names', () => {
    expect(() => validateBranchName('feature/foo')).not.toThrow();
    expect(() => validateBranchName('release/2026-05')).not.toThrow();
  });

  it('still rejects path-component names and NUL', () => {
    expect(() => validateBranchName('')).toThrow();
    expect(() => validateBranchName('.')).toThrow();
    expect(() => validateBranchName('..')).toThrow();
    expect(() => validateBranchName('foo\0bar')).toThrow();
  });
});

describe('setupBranchWorktrees with a slash-bearing branch', () => {
  const branch = 'feature/some-work';
  const dir = 'feature-some-work';

  it('creates the worktree under a sanitised directory but keeps the real git ref', async () => {
    const result = await setupBranchWorktrees(conception, branch, { repos: ['demo'] });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      repo: 'demo',
      path: join(worktreesRoot, dir, 'demo'),
    });
    // No raw `feature/` directory was created — slash was flattened.
    expect(existsSync(join(worktreesRoot, 'feature'))).toBe(false);
    // The branch ref itself carries the real `feature/some-work` name.
    const branches = await git(repo, 'branch', '--list', branch);
    expect(branches).toContain(branch);
  });

  it('check reports the same sanitised expectedWorktree', async () => {
    // Drop a README declaring the branch so inspect has an item to track.
    const projectDir = join(conception, 'projects/2026-05/2026-05-15-slash-branch');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'README.md'),
      [
        '---',
        'date: 2026-05-15',
        'kind: project',
        'status: now',
        'apps:',
        '  - demo',
        `branch: ${branch}`,
        '---',
        '',
        '# Test',
      ].join('\n'),
    );
    await setupBranchWorktrees(conception, branch, { repos: ['demo'] });
    const state = await checkBranchState(conception, branch);
    expect(state.repos).toHaveLength(1);
    expect(state.repos[0].expectedWorktree).toBe(join(worktreesRoot, dir, 'demo'));
    expect(state.repos[0].worktreeExists).toBe(true);
    expect(state.missing).toEqual([]);
  });

  it('remove also resolves to the sanitised directory', async () => {
    await setupBranchWorktrees(conception, branch, { repos: ['demo'] });
    expect(existsSync(join(worktreesRoot, dir, 'demo'))).toBe(true);
    const result = await removeBranchWorktrees(conception, branch, { repos: ['demo'] });
    expect(result.removed).toEqual([{ repo: 'demo', path: join(worktreesRoot, dir, 'demo') }]);
    expect(result.parentRemoved).toBe(true);
    expect(existsSync(join(worktreesRoot, dir))).toBe(false);
  });
});

describe('implicit-mode resolution with `#`-prefixed apps', () => {
  // The Apps table column in the conception README accepts `#<repo>`; project
  // headers mirror that. The canonical repo name in `condash.json` is bare,
  // so the resolver must strip `#` before lookup. Issue: setup/remove
  // returned empty `created[]` / `notPresent: ["#<name>"]` until the strip
  // was added.
  const branch = 'at-prefix-implicit';

  function writeDeclaringReadme(): void {
    const projectDir = join(conception, 'projects/2026-05/2026-05-14-at-prefix');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'README.md'),
      [
        '---',
        'date: 2026-05-14',
        'kind: project',
        'status: now',
        'apps:',
        '  - "#demo"',
        `branch: ${branch}`,
        '---',
        '',
        '# Test',
      ].join('\n'),
    );
  }

  it('setup resolves `#demo` to repo `demo` in implicit mode', async () => {
    writeDeclaringReadme();
    const result = await setupBranchWorktrees(conception, branch);
    expect(result.created).toEqual([{ repo: 'demo', path: join(worktreesRoot, branch, 'demo') }]);
    expect(result.blocked).toEqual([]);
    expect(existsSync(join(worktreesRoot, branch, 'demo'))).toBe(true);
  });

  it('check enumerates the `demo` per-repo state when the README says `#demo`', async () => {
    writeDeclaringReadme();
    await setupBranchWorktrees(conception, branch);
    const state = await checkBranchState(conception, branch);
    expect(state.repos).toHaveLength(1);
    expect(state.repos[0].name).toBe('demo');
    expect(state.repos[0].worktreeExists).toBe(true);
    expect(state.missing).toEqual([]);
  });

  it('remove resolves `#demo` to repo `demo` in implicit mode', async () => {
    writeDeclaringReadme();
    await setupBranchWorktrees(conception, branch);
    const result = await removeBranchWorktrees(conception, branch);
    expect(result.removed).toEqual([{ repo: 'demo', path: join(worktreesRoot, branch, 'demo') }]);
    expect(result.notPresent).toEqual([]);
    expect(existsSync(join(worktreesRoot, branch, 'demo'))).toBe(false);
  });
});

describe('apps handle differs from the repo directory name', () => {
  // `#vcoeur` is the canonical handle of a repo whose directory is `vcoeur.com`.
  // Before the fix, the apps→repo lookup keyed only on the directory name, so
  // `#vcoeur` resolved to nothing and worktrees needed an explicit
  // `--repo vcoeur.com`. All three operations must now resolve `#vcoeur` to the
  // `vcoeur.com` worktree directory.
  const branch = 'handle-ne-name';
  const repoDir = 'vcoeur.com';

  async function setupVcoeurRepo(): Promise<void> {
    writeFileSync(
      join(conception, 'condash.json'),
      JSON.stringify(
        {
          workspace_path: join(tmp, 'workspace'),
          worktrees_path: worktreesRoot,
          repositories: [{ handle: 'vcoeur', path: repoDir, aliases: [repoDir] }],
        },
        null,
        2,
      ),
    );
    await git(join(tmp, 'workspace'), 'init', '-q', '-b', 'main', repoDir);
    const r = join(tmp, 'workspace', repoDir);
    await git(r, 'config', 'user.email', 'test@example.com');
    await git(r, 'config', 'user.name', 'Test');
    await git(r, 'commit', '-q', '--allow-empty', '-m', 'init');
    const projectDir = join(conception, 'projects/2026-05/2026-05-30-vcoeur');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'README.md'),
      [
        '---',
        'date: 2026-05-30',
        'kind: project',
        'status: now',
        'apps:',
        '  - "#vcoeur"',
        `branch: ${branch}`,
        '---',
        '',
        '# Test',
      ].join('\n'),
    );
  }

  it('setup resolves `#vcoeur` to the `vcoeur.com` worktree directory', async () => {
    await setupVcoeurRepo();
    const result = await setupBranchWorktrees(conception, branch);
    expect(result.created).toEqual([{ repo: repoDir, path: join(worktreesRoot, branch, repoDir) }]);
    expect(result.blocked).toEqual([]);
    expect(existsSync(join(worktreesRoot, branch, repoDir))).toBe(true);
  });

  it('check enumerates `vcoeur.com` with no false orphan', async () => {
    await setupVcoeurRepo();
    await setupBranchWorktrees(conception, branch);
    const state = await checkBranchState(conception, branch);
    expect(state.repos).toHaveLength(1);
    expect(state.repos[0].name).toBe(repoDir);
    expect(state.repos[0].worktreeExists).toBe(true);
    expect(state.missing).toEqual([]);
    expect(state.orphan).toEqual([]);
  });

  it('remove resolves `#vcoeur` and cleans the worktree', async () => {
    await setupVcoeurRepo();
    await setupBranchWorktrees(conception, branch);
    const result = await removeBranchWorktrees(conception, branch);
    expect(result.removed).toEqual([{ repo: repoDir, path: join(worktreesRoot, branch, repoDir) }]);
    expect(result.notPresent).toEqual([]);
    expect(existsSync(join(worktreesRoot, branch, repoDir))).toBe(false);
  });

  it('an explicit `--repo vcoeur` handle maps to the same `vcoeur.com` worktree', async () => {
    await setupVcoeurRepo();
    const result = await setupBranchWorktrees(conception, branch, { repos: ['vcoeur'] });
    expect(result.created).toEqual([{ repo: repoDir, path: join(worktreesRoot, branch, repoDir) }]);
  });
});

describe('resolveBase', () => {
  it('lets an explicit --base win over README values', () => {
    expect(resolveBase('b', 'override', [{ slug: 'a', base: 'main' }])).toBe('override');
  });

  it('uses the unanimous **Base** across declaring items', () => {
    expect(
      resolveBase('b', undefined, [
        { slug: 'a', base: 'release/1' },
        { slug: 'c', base: 'release/1' },
        { slug: 'd', base: null },
      ]),
    ).toBe('release/1');
  });

  it('returns undefined when no item declares a base', () => {
    expect(resolveBase('b', undefined, [{ slug: 'a', base: null }])).toBeUndefined();
    expect(resolveBase('b', undefined, [])).toBeUndefined();
  });

  it('throws on disagreement, naming the disagreeing items', () => {
    expect(() =>
      resolveBase('b', undefined, [
        { slug: 'a', base: 'main' },
        { slug: 'c', base: 'release/1' },
      ]),
    ).toThrow(/disagree.*main \(a\).*release\/1 \(c\)/s);
  });
});

describe('isSafeRelativePath', () => {
  it('accepts plain relative paths', () => {
    expect(isSafeRelativePath('.env')).toBe(true);
    expect(isSafeRelativePath('config/.env.local')).toBe(true);
    expect(isSafeRelativePath('deep/nested/file.json')).toBe(true);
  });

  it('rejects traversal, absolute, drive-prefixed, NUL, and empty paths', () => {
    expect(isSafeRelativePath('../outside')).toBe(false);
    expect(isSafeRelativePath('a/../b')).toBe(false);
    expect(isSafeRelativePath('a\\..\\b')).toBe(false);
    expect(isSafeRelativePath('/abs/path')).toBe(false);
    expect(isSafeRelativePath('\\\\share')).toBe(false);
    expect(isSafeRelativePath('C:\\windows')).toBe(false);
    expect(isSafeRelativePath('C:/windows')).toBe(false);
    expect(isSafeRelativePath('a\0b')).toBe(false);
    expect(isSafeRelativePath('')).toBe(false);
    expect(isSafeRelativePath('./x')).toBe(false);
  });
});

describe('pinned_branch blocking', () => {
  it('blocks setup for a repo pinned to a fixed branch', async () => {
    writeFileSync(
      join(conception, 'condash.json'),
      JSON.stringify(
        {
          workspace_path: join(tmp, 'workspace'),
          worktrees_path: worktreesRoot,
          repositories: [{ name: 'demo', pinned_branch: 'main' }],
        },
        null,
        2,
      ),
    );
    const result = await setupBranchWorktrees(conception, 'pinned-block', { repos: ['demo'] });
    expect(result.created).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toContain("pinned to 'main'");
    expect(existsSync(join(worktreesRoot, 'pinned-block', 'demo'))).toBe(false);
  });
});

describe('install failure diagnostics', () => {
  it('captures a stderr tail when the install command fails', async () => {
    writeFileSync(
      join(conception, 'condash.json'),
      JSON.stringify(
        {
          workspace_path: join(tmp, 'workspace'),
          worktrees_path: worktreesRoot,
          repositories: [{ name: 'demo', install: 'echo first >&2; echo boom >&2; exit 3' }],
        },
        null,
        2,
      ),
    );
    const result = await setupBranchWorktrees(conception, 'install-fail', { repos: ['demo'] });
    expect(result.created).toHaveLength(1);
    expect(result.installRan).toHaveLength(1);
    expect(result.installRan[0].ok).toBe(false);
    expect(result.installRan[0].stderrTail).toContain('boom');
  });

  it('reports ok with no stderrTail when the install succeeds', async () => {
    writeFileSync(
      join(conception, 'condash.json'),
      JSON.stringify(
        {
          workspace_path: join(tmp, 'workspace'),
          worktrees_path: worktreesRoot,
          repositories: [{ name: 'demo', install: 'true' }],
        },
        null,
        2,
      ),
    );
    const result = await setupBranchWorktrees(conception, 'install-ok', { repos: ['demo'] });
    expect(result.installRan).toEqual([{ repo: 'demo', command: 'true', ok: true }]);
  });
});

describe('no-base fallback branches from the default tip, not HEAD', () => {
  it('uses local main when the primary checkout sits on another branch', async () => {
    // Primary checkout moves to a feature branch with an extra commit; a new
    // branch with no base must still start from main's tip, not the feature
    // branch's HEAD (the stale-base trap).
    const mainSha = (await git(repo, 'rev-parse', 'main')).trim();
    await git(repo, 'checkout', '-q', '-b', 'stale-feature');
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'feature work');
    const featureSha = (await git(repo, 'rev-parse', 'HEAD')).trim();
    expect(featureSha).not.toBe(mainSha);

    const result = await setupBranchWorktrees(conception, 'fresh-branch', { repos: ['demo'] });
    expect(result.created).toHaveLength(1);
    expect(result.base).toBeNull();
    const target = join(worktreesRoot, 'fresh-branch', 'demo');
    const headSha = (await git(target, 'rev-parse', 'HEAD')).trim();
    expect(headSha).toBe(mainSha);
  });
});

describe('stale-base warning (baseBehind)', () => {
  it('reports how far the base trails its already-fetched upstream', async () => {
    // origin: a separate repo that gains a commit AFTER the clone, then the
    // clone fetches — local main is now 1 behind origin/main.
    const originRoot = join(tmp, 'origin');
    mkdirSync(originRoot, { recursive: true });
    await git(originRoot, 'init', '-q', '-b', 'main', 'demo2');
    const origin = join(originRoot, 'demo2');
    await git(origin, 'config', 'user.email', 'test@example.com');
    await git(origin, 'config', 'user.name', 'Test');
    await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init');
    await git(join(tmp, 'workspace'), 'clone', '-q', origin, 'demo2');
    const clone = join(tmp, 'workspace', 'demo2');
    await git(clone, 'config', 'user.email', 'test@example.com');
    await git(clone, 'config', 'user.name', 'Test');
    await git(origin, 'commit', '-q', '--allow-empty', '-m', 'newer upstream work');
    await git(clone, 'fetch', '-q', 'origin');

    writeFileSync(
      join(conception, 'condash.json'),
      JSON.stringify(
        {
          workspace_path: join(tmp, 'workspace'),
          worktrees_path: worktreesRoot,
          repositories: [{ name: 'demo2' }],
        },
        null,
        2,
      ),
    );
    const result = await setupBranchWorktrees(conception, 'behind-check', {
      repos: ['demo2'],
      base: 'main',
    });
    expect(result.created).toHaveLength(1);
    expect(result.baseBehind).toEqual([
      { repo: 'demo2', ref: 'main', upstream: 'origin/main', behind: 1 },
    ]);
  });

  it('stays empty when the base has no upstream', async () => {
    const result = await setupBranchWorktrees(conception, 'no-upstream', {
      repos: ['demo'],
      base: 'main',
    });
    expect(result.created).toHaveLength(1);
    expect(result.baseBehind).toEqual([]);
  });
});

describe('setup-side flattened-path collision / stale-dir classification', () => {
  it('reports present-but-different-branch as blocked, not alreadyPresent', async () => {
    // `coll/ision` and `coll-ision` share the directory key `coll-ision`.
    await setupBranchWorktrees(conception, 'coll/ision', { repos: ['demo'] });
    const result = await setupBranchWorktrees(conception, 'coll-ision', { repos: ['demo'] });
    expect(result.created).toEqual([]);
    expect(result.alreadyPresent).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toContain("on branch 'coll/ision'");
    expect(result.blocked[0].reason).toContain('flattened-path collision');
  });

  it('reports a non-worktree directory at the target as blocked', async () => {
    const target = join(worktreesRoot, 'stale-dir', 'demo');
    mkdirSync(target, { recursive: true });
    const result = await setupBranchWorktrees(conception, 'stale-dir', { repos: ['demo'] });
    expect(result.created).toEqual([]);
    expect(result.alreadyPresent).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toContain('not a registered worktree');
  });

  it('still reports a genuine same-branch worktree as alreadyPresent', async () => {
    await setupBranchWorktrees(conception, 'idempotent', { repos: ['demo'] });
    const result = await setupBranchWorktrees(conception, 'idempotent', { repos: ['demo'] });
    expect(result.created).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect(result.alreadyPresent).toEqual([
      { repo: 'demo', path: join(worktreesRoot, 'idempotent', 'demo') },
    ]);
  });
});

describe('declared env: file copy', () => {
  // Issue #450: the env copy only ever ran on the creation path, so a
  // worktree missing its declared (gitignored, therefore never checked out)
  // env files could not be repaired — re-running setup printed "Already
  // present" and copied nothing.
  function writeEnvConfig(
    envFiles: string[] = ['.env'],
    extra: Record<string, unknown> = {},
  ): void {
    writeFileSync(
      join(conception, 'condash.json'),
      JSON.stringify(
        {
          workspace_path: join(tmp, 'workspace'),
          worktrees_path: worktreesRoot,
          repositories: [{ name: 'demo', env: envFiles, ...extra }],
        },
        null,
        2,
      ),
    );
  }

  it('copies declared env files when it creates the worktree', async () => {
    writeEnvConfig();
    writeFileSync(join(repo, '.env'), 'VITE_API=primary\n');
    const result = await setupBranchWorktrees(conception, 'env-create', { repos: ['demo'] });
    expect(result.created).toHaveLength(1);
    expect(result.envCopied).toEqual([{ repo: 'demo', files: ['.env'] }]);
    const target = join(worktreesRoot, 'env-create', 'demo');
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe('VITE_API=primary\n');
  });

  it('backfills declared env files into a worktree that already exists', async () => {
    // The issue's repro: the worktree is created by a raw `git worktree add`
    // (the documented fallback when no item declares the branch), so it never
    // received the declared env file.
    writeEnvConfig(['.env'], { install: 'touch installed.marker' });
    writeFileSync(join(repo, '.env'), 'VITE_API=primary\n');
    const target = join(worktreesRoot, 'env-backfill', 'demo');
    await git(repo, 'worktree', 'add', '-q', target, '-b', 'env-backfill');
    expect(existsSync(join(target, '.env'))).toBe(false);

    const result = await setupBranchWorktrees(conception, 'env-backfill', { repos: ['demo'] });
    expect(result.created).toEqual([]);
    expect(result.alreadyPresent).toEqual([{ repo: 'demo', path: target }]);
    expect(result.envCopied).toEqual([{ repo: 'demo', files: ['.env'] }]);
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe('VITE_API=primary\n');
    // `install:` stays out of scope on the already-present path — a re-run
    // must not kick off an unrequested `npm ci` / `mvn clean install`.
    expect(result.installRan).toEqual([]);
    expect(existsSync(join(target, 'installed.marker'))).toBe(false);
  });

  it('never clobbers an env file the worktree already has', async () => {
    // A worktree's env file is often deliberately divergent (a different port
    // so two branches can run side by side); only the genuinely missing file
    // is backfilled.
    writeEnvConfig(['.env', '.env.local']);
    writeFileSync(join(repo, '.env'), 'PORT=5600\n');
    writeFileSync(join(repo, '.env.local'), 'TOKEN=primary\n');
    await setupBranchWorktrees(conception, 'env-divergent', { repos: ['demo'] });
    const target = join(worktreesRoot, 'env-divergent', 'demo');
    writeFileSync(join(target, '.env'), 'PORT=5610\n');
    rmSync(join(target, '.env.local'));

    const result = await setupBranchWorktrees(conception, 'env-divergent', { repos: ['demo'] });
    expect(result.alreadyPresent).toHaveLength(1);
    expect(result.envCopied).toEqual([{ repo: 'demo', files: ['.env.local'] }]);
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe('PORT=5610\n');
    expect(readFileSync(join(target, '.env.local'), 'utf8')).toBe('TOKEN=primary\n');
  });

  it('--no-env suppresses both the create copy and the backfill', async () => {
    writeEnvConfig();
    writeFileSync(join(repo, '.env'), 'VITE_API=primary\n');
    const created = await setupBranchWorktrees(conception, 'env-skip', {
      repos: ['demo'],
      skipEnv: true,
    });
    expect(created.created).toHaveLength(1);
    expect(created.envCopied).toEqual([]);
    const target = join(worktreesRoot, 'env-skip', 'demo');
    expect(existsSync(join(target, '.env'))).toBe(false);

    const again = await setupBranchWorktrees(conception, 'env-skip', {
      repos: ['demo'],
      skipEnv: true,
    });
    expect(again.alreadyPresent).toHaveLength(1);
    expect(again.envCopied).toEqual([]);
    expect(existsSync(join(target, '.env'))).toBe(false);
  });
});

describe('checkBranchState input validation + active-only union', () => {
  it('rejects branch names that sanitise to path components', async () => {
    await expect(checkBranchState(conception, '..')).rejects.toThrow(/path component/);
  });

  it('excludes done items from the wanted-repo union (their leftovers are orphans)', async () => {
    const projectDir = join(conception, 'projects/2026-06/2026-06-02-done-item');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'README.md'),
      [
        '---',
        'date: 2026-06-02',
        'kind: project',
        'status: done',
        'apps:',
        '  - demo',
        'branch: done-branch',
        '---',
        '',
        '# T',
      ].join('\n'),
    );
    await git(
      repo,
      'worktree',
      'add',
      '-q',
      join(worktreesRoot, 'done-branch', 'demo'),
      '-b',
      'done-branch',
    );
    const state = await checkBranchState(conception, 'done-branch');
    // The done item still shows under declaringItems…
    expect(state.declaringItems).toHaveLength(1);
    // …but claims no repos: nothing missing, and the leftover dir is an orphan.
    expect(state.repos).toEqual([]);
    expect(state.missing).toEqual([]);
    expect(state.orphan).toEqual(['demo']);
  });
});

process.on('exit', () => {
  if (prevXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
});
