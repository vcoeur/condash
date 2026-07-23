import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec as execFile } from '../exec';
import { removeBranchWorktrees } from './remove';

let prevXdgConfigHome: string | undefined;
let xdgHome: string;

let tmp: string;
let conception: string;
let repo: string;
let worktreesRoot: string;
const branch = 'partial-test';

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
  if (tmp) {
    // Restore writable bits before rm to avoid EACCES on the read-only file
    // we plant to provoke a partial remove.
    try {
      chmodSync(join(worktreesRoot, branch, 'demo', 'node_modules'), 0o755);
      chmodSync(join(worktreesRoot, branch, 'demo', 'node_modules', 'pinned.js'), 0o644);
    } catch {
      // dir may already be partially gone — ignore.
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-remove-'));
  conception = join(tmp, 'conception');
  repo = join(tmp, 'workspace', 'demo');
  worktreesRoot = join(tmp, 'wt');
  mkdirSync(conception, { recursive: true });
  mkdirSync(join(tmp, 'workspace'), { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });

  // Conception config: one repo `demo` under `workspace_path`, worktrees in
  // `worktrees_path`. No projects directory needed — we pass `repos:` to
  // `removeBranchWorktrees` directly so it skips item discovery.
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

  // Bare git repo + first commit so we can branch off it.
  await git(join(tmp, 'workspace'), 'init', '-q', '-b', 'main', 'demo');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');

  // Worktree on the test branch with rebuildable artifacts that block git's
  // own rm: a read-only file inside `node_modules/`. With `--force`, git
  // deregisters first then fails on the chmod-restricted unlink — exactly
  // the partial-removed state issue #124 reports.
  const target = join(worktreesRoot, branch, 'demo');
  await git(repo, 'worktree', 'add', '-q', target, '-b', branch);
  mkdirSync(join(target, 'node_modules'));
  writeFileSync(join(target, 'node_modules', 'pinned.js'), 'x');
  chmodSync(join(target, 'node_modules', 'pinned.js'), 0o444);
  chmodSync(join(target, 'node_modules'), 0o555);
});

describe('removeBranchWorktrees', () => {
  it('reports partiallyRemoved when --force deregisters but rm fails', async () => {
    const result = await removeBranchWorktrees(conception, branch, {
      repos: ['demo'],
      force: true,
    });
    expect(result.removed).toEqual([]);
    expect(result.protected).toEqual([]);
    expect(result.partiallyRemoved).toHaveLength(1);
    expect(result.partiallyRemoved[0]).toMatchObject({
      repo: 'demo',
      path: join(worktreesRoot, branch, 'demo'),
    });
    expect(result.partiallyRemoved[0].reason).toContain('git worktree remove failed');
    // Registry was deregistered: `git worktree list` no longer mentions it.
    const wts = await git(repo, 'worktree', 'list', '--porcelain');
    expect(wts).not.toContain(join(worktreesRoot, branch, 'demo'));
    // Disk still has the leftover dir.
    expect(existsSync(join(worktreesRoot, branch, 'demo'))).toBe(true);
  });

  it('classifies refusal-without-deregister as protected, not partially removed', async () => {
    // Without --force, git refuses outright: no registry mutation, dir intact.
    const result = await removeBranchWorktrees(conception, branch, { repos: ['demo'] });
    expect(result.removed).toEqual([]);
    expect(result.partiallyRemoved).toEqual([]);
    expect(result.protected).toHaveLength(1);
    expect(result.protected[0].repo).toBe('demo');
    expect(result.protected[0].reason).toContain('git worktree remove failed');
    const wts = await git(repo, 'worktree', 'list', '--porcelain');
    expect(wts).toContain(join(worktreesRoot, branch, 'demo'));
  });

  it('--force-rm completes the cleanup and reports the repo under removed[]', async () => {
    const result = await removeBranchWorktrees(conception, branch, {
      repos: ['demo'],
      forceRm: true,
    });
    expect(result.partiallyRemoved).toEqual([]);
    expect(result.protected).toEqual([]);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toMatchObject({
      repo: 'demo',
      path: join(worktreesRoot, branch, 'demo'),
    });
    // Both the registry and the disk are clean now.
    const wts = await git(repo, 'worktree', 'list', '--porcelain');
    expect(wts).not.toContain(join(worktreesRoot, branch, 'demo'));
    expect(existsSync(join(worktreesRoot, branch, 'demo'))).toBe(false);
    // Parent branch dir was empty after — it should have been rmdir'd too.
    expect(result.parentRemoved).toBe(true);
  });
});

describe('non-worktree directory at the expected path (orphan guard)', () => {
  it('survives --force-rm and is reported under orphaned[]', async () => {
    // A plain directory (manual clone, leftover) that was NEVER a registered
    // worktree. Before the pre-removal registry snapshot, `git worktree
    // remove` failed, `isStillRegistered` said no (it never was), and
    // --force-rm erased it — unpushed commits included.
    const orphanBranch = 'orphan-test';
    const target = join(worktreesRoot, orphanBranch, 'demo');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'precious.txt'), 'unpushed work');

    const result = await removeBranchWorktrees(conception, orphanBranch, {
      repos: ['demo'],
      forceRm: true,
    });
    expect(result.removed).toEqual([]);
    expect(result.partiallyRemoved).toEqual([]);
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0]).toMatchObject({ repo: 'demo', path: target });
    expect(result.orphaned[0].reason).toContain('not a registered worktree');
    // The directory and its contents are intact.
    expect(existsSync(join(target, 'precious.txt'))).toBe(true);
  });
});

describe('flattened-path collision (foo/bar vs foo-bar)', () => {
  it("refuses to remove the OTHER branch's worktree sharing the directory key", async () => {
    // `branchToDir` maps both `coll/ision` and `coll-ision` to `coll-ision`.
    // The worktree on disk belongs to `coll/ision`; removing `coll-ision`
    // must not delete it.
    const target = join(worktreesRoot, 'coll-ision', 'demo');
    await git(repo, 'worktree', 'add', '-q', target, '-b', 'coll/ision');

    const result = await removeBranchWorktrees(conception, 'coll-ision', {
      repos: ['demo'],
      forceRm: true,
    });
    expect(result.removed).toEqual([]);
    expect(result.orphaned).toEqual([]);
    expect(result.protected).toHaveLength(1);
    expect(result.protected[0].reason).toContain("on branch 'coll/ision'");
    expect(result.protected[0].reason).toContain('flattened-path collision');
    // Worktree intact: still registered and on disk.
    const wts = await git(repo, 'worktree', 'list', '--porcelain');
    expect(wts).toContain(target);
    expect(existsSync(target)).toBe(true);
  });
});

describe('implicit-mode protection (two items, one branch)', () => {
  const sharedBranch = 'shared-branch';

  function writeItem(slug: string, status: string): void {
    const dir = join(conception, 'projects', '2026-06', `2026-06-01-${slug}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'README.md'),
      [
        '---',
        'date: 2026-06-01',
        'kind: project',
        `status: ${status}`,
        'apps:',
        '  - demo',
        `branch: ${sharedBranch}`,
        '---',
        '',
        '# T',
      ].join('\n'),
    );
  }

  it('protects a repo claimed by two active items in implicit mode', async () => {
    writeItem('item-a', 'now');
    writeItem('item-b', 'review');
    const target = join(worktreesRoot, sharedBranch, 'demo');
    await git(repo, 'worktree', 'add', '-q', target, '-b', sharedBranch);

    const result = await removeBranchWorktrees(conception, sharedBranch);
    expect(result.removed).toEqual([]);
    expect(result.protected).toHaveLength(1);
    expect(result.protected[0].repo).toBe('demo');
    expect(result.protected[0].reason).toContain('2 active items');
    expect(existsSync(target)).toBe(true);
  });

  it('removes when only one of the two items is still active', async () => {
    writeItem('item-a', 'now');
    writeItem('item-b', 'done');
    const target = join(worktreesRoot, sharedBranch, 'demo');
    await git(repo, 'worktree', 'add', '-q', target, '-b', sharedBranch);

    const result = await removeBranchWorktrees(conception, sharedBranch);
    expect(result.protected).toEqual([]);
    expect(result.removed).toEqual([{ repo: 'demo', path: target }]);
    expect(existsSync(target)).toBe(false);
  });

  it('an explicit --repo list overrides the implicit shared-claim protection', async () => {
    writeItem('item-a', 'now');
    writeItem('item-b', 'now');
    const target = join(worktreesRoot, sharedBranch, 'demo');
    await git(repo, 'worktree', 'add', '-q', target, '-b', sharedBranch);

    const result = await removeBranchWorktrees(conception, sharedBranch, { repos: ['demo'] });
    expect(result.protected).toEqual([]);
    expect(result.removed).toEqual([{ repo: 'demo', path: target }]);
  });
});

describe('long-lived branch protection', () => {
  it('protects default long-lived branches (master) by default', async () => {
    await git(repo, 'branch', 'master');
    const target = join(worktreesRoot, 'master', 'demo');
    await git(repo, 'worktree', 'add', '-q', target, 'master');
    const result = await removeBranchWorktrees(conception, 'master', { repos: ['demo'] });
    expect(result.removed).toEqual([]);
    expect(result.partiallyRemoved).toEqual([]);
    expect(result.protected).toHaveLength(1);
    expect(result.protected[0].repo).toBe('demo');
    expect(result.protected[0].reason).toContain('long-lived branch');
    expect(existsSync(target)).toBe(true);
  });

  it('protects branches matching configured globs', async () => {
    writeFileSync(
      join(conception, 'condash.json'),
      JSON.stringify(
        {
          workspace_path: join(tmp, 'workspace'),
          worktrees_path: worktreesRoot,
          repositories: [{ name: 'demo' }],
          long_lived_branches: ['preprod', 'release/*'],
        },
        null,
        2,
      ),
    );
    const target = join(worktreesRoot, 'release-1.0', 'demo');
    await git(repo, 'worktree', 'add', '-q', target, '-b', 'release/1.0');
    const result = await removeBranchWorktrees(conception, 'release/1.0', { repos: ['demo'] });
    expect(result.removed).toEqual([]);
    expect(result.partiallyRemoved).toEqual([]);
    expect(result.protected).toHaveLength(1);
    expect(result.protected[0].repo).toBe('demo');
    expect(result.protected[0].reason).toContain('release/*');
    expect(existsSync(target)).toBe(true);
  });

  it('still removes a non-long-lived branch when a list is configured', async () => {
    writeFileSync(
      join(conception, 'condash.json'),
      JSON.stringify(
        {
          workspace_path: join(tmp, 'workspace'),
          worktrees_path: worktreesRoot,
          repositories: [{ name: 'demo' }],
          long_lived_branches: ['preprod'],
        },
        null,
        2,
      ),
    );
    const target = join(worktreesRoot, 'feature-xyz', 'demo');
    await git(repo, 'worktree', 'add', '-q', target, '-b', 'feature-xyz');
    const result = await removeBranchWorktrees(conception, 'feature-xyz', { repos: ['demo'] });
    expect(result.protected).toEqual([]);
    expect(result.partiallyRemoved).toEqual([]);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toMatchObject({ repo: 'demo', path: target });
    expect(existsSync(target)).toBe(false);
  });
});

// Restore env at module unload so the test process leaves no trace.
process.on('exit', () => {
  if (prevXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
});

// "no trace" was aspirational: the per-test `tmp` dirs are reaped in afterEach,
// but this beforeAll-scoped XDG home was not, leaking one condash-xdg-* per run.
// Cleanup must be an `afterAll`, not the process.on('exit') above — under
// vitest's pooled workers the 'exit' event does not fire between files.
afterAll(() => {
  if (xdgHome) rmSync(xdgHome, { recursive: true, force: true });
});
