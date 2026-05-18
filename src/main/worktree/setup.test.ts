/**
 * Issue #168: `condash worktrees setup` used to refuse any branch name
 * containing `/`, locking out the standard `feature/x` / `chore/x` patterns.
 * The setup mutator now flattens slashes to `-` for the on-disk directory
 * key while leaving the actual git ref intact.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec as execFile } from '../exec';
import { setupBranchWorktrees } from './setup';
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

describe('implicit-mode resolution with `@`-prefixed apps', () => {
  // The Apps table column in the conception README accepts `@<repo>`; project
  // headers mirror that. The canonical repo name in `condash.json` is bare,
  // so the resolver must strip `@` before lookup. Issue: setup/remove
  // returned empty `created[]` / `notPresent: ["@<name>"]` until the strip
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
        '  - "@demo"',
        `branch: ${branch}`,
        '---',
        '',
        '# Test',
      ].join('\n'),
    );
  }

  it('setup resolves `@demo` to repo `demo` in implicit mode', async () => {
    writeDeclaringReadme();
    const result = await setupBranchWorktrees(conception, branch);
    expect(result.created).toEqual([{ repo: 'demo', path: join(worktreesRoot, branch, 'demo') }]);
    expect(result.blocked).toEqual([]);
    expect(existsSync(join(worktreesRoot, branch, 'demo'))).toBe(true);
  });

  it('check enumerates the `demo` per-repo state when the README says `@demo`', async () => {
    writeDeclaringReadme();
    await setupBranchWorktrees(conception, branch);
    const state = await checkBranchState(conception, branch);
    expect(state.repos).toHaveLength(1);
    expect(state.repos[0].name).toBe('demo');
    expect(state.repos[0].worktreeExists).toBe(true);
    expect(state.missing).toEqual([]);
  });

  it('remove resolves `@demo` to repo `demo` in implicit mode', async () => {
    writeDeclaringReadme();
    await setupBranchWorktrees(conception, branch);
    const result = await removeBranchWorktrees(conception, branch);
    expect(result.removed).toEqual([{ repo: 'demo', path: join(worktreesRoot, branch, 'demo') }]);
    expect(result.notPresent).toEqual([]);
    expect(existsSync(join(worktreesRoot, branch, 'demo'))).toBe(false);
  });
});

process.on('exit', () => {
  if (prevXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
});
