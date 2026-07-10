/**
 * Integration tests for the sweeper against a real git repo.
 *
 * `syncRun` shells out through `exec`, which inherits `process.env`, so the
 * developer's global git config (hooks path, gpgsign, aliases) is pinned off
 * for the whole file rather than per-invocation.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeProjectReadme } from '../../cli/commands/test-helpers';
import { exec } from '../exec';
import { syncCommit, syncRun, SyncRefusedError } from './run';

const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

const RUN_DEFAULTS = { dryRun: false, push: false, quietPeriodSeconds: 90 };

let savedGlobal: string | undefined;
let savedSystem: string | undefined;

beforeAll(() => {
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  savedSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
});

afterAll(() => {
  restore('GIT_CONFIG_GLOBAL', savedGlobal);
  restore('GIT_CONFIG_SYSTEM', savedSystem);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

/** A git-backed conception with the real `.gitignore` sentinels. */
async function makeGitConception(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'condash-sync-test-'));
  await fs.mkdir(join(root, 'projects'), { recursive: true });
  await fs.mkdir(join(root, 'knowledge'), { recursive: true });
  await fs.writeFile(
    join(root, '.gitignore'),
    ['projects/.index-dirty', 'knowledge/.index-dirty', 'projects/**/local/', ''].join('\n'),
  );

  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'Test');
  await git(root, 'add', '.gitignore');
  await git(root, 'commit', '-q', '-m', 'init');
  return root;
}

/** Push a path's mtime past any quiet period. */
async function settle(...paths: string[]): Promise<void> {
  const when = HOUR_AGO();
  for (const path of paths) await fs.utimes(path, when, when);
}

async function subjects(root: string): Promise<string[]> {
  const log = await git(root, 'log', '--format=%s');
  return log.trim().split('\n').filter(Boolean);
}

describe('syncRun', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeGitConception();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('commits one commit per item, knowledge next, indexes last', async () => {
    const alpha = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
      apps: ['condash'],
    });
    const beta = await writeProjectReadme(root, 'beta', {
      date: '2026-07-11',
      kind: 'project',
      status: 'now',
      apps: ['condash'],
    });
    const note = join(root, 'projects', '2026-07', '2026-07-10-alpha', 'notes', '01-design.md');
    await fs.mkdir(join(root, 'projects', '2026-07', '2026-07-10-alpha', 'notes'));
    await fs.writeFile(note, '# design\n');
    await fs.mkdir(join(root, 'knowledge', 'internal'), { recursive: true });
    const knowledge = join(root, 'knowledge', 'internal', 'condash.md');
    await fs.writeFile(knowledge, '# condash\n');
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await settle(alpha, beta, note, knowledge);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.locked).toBe(false);
    expect(report.regeneratedTrees).toEqual(['projects']);
    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      '2026-07-11-beta: sync',
      'knowledge: sync',
      'indexes: sync',
    ]);
    for (const commit of report.commits) expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);

    // Newest first, so the log is the reverse of the commit order.
    expect(await subjects(root)).toEqual([
      'indexes: sync',
      'knowledge: sync',
      '2026-07-11-beta: sync',
      '2026-07-10-alpha: sync',
      'init',
    ]);

    // The alpha commit carries the README and the note, and nothing else.
    const alphaFiles = await git(root, 'show', '--name-only', '--format=', 'HEAD~3');
    expect(alphaFiles.trim().split('\n').sort()).toEqual([
      'projects/2026-07/2026-07-10-alpha/README.md',
      'projects/2026-07/2026-07-10-alpha/notes/01-design.md',
    ]);

    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
  });

  it('leaves paths younger than the quiet period for the next tick', async () => {
    await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project', status: 'now' });

    const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 3600 });

    expect(report.commits).toEqual([]);
    expect(report.skipped).toEqual([
      { path: 'projects/2026-07/2026-07-10-alpha/README.md', reason: 'quiet-period' },
    ]);
    expect(await subjects(root)).toEqual(['init']);
  });

  it('defers index regeneration while any item is still inside the quiet period', async () => {
    // Regression: the index is fan-in over every item, so regenerating it here
    // would commit a `projects/index.md` whose bullets point at an item
    // directory that this sweep deliberately did not commit — a dangling
    // reference on main. The marker must survive for the next tick.
    await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project', status: 'now' });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');

    const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 3600 });

    expect(report.indexesDeferred).toBe(true);
    expect(report.regeneratedTrees).toEqual([]);
    expect(report.commits).toEqual([]);
    expect(await subjects(root)).toEqual(['init']);
    // Marker intact, so the next settled tick regenerates.
    await expect(fs.stat(join(root, 'projects', '.index-dirty'))).resolves.toBeTruthy();
    // And no index.md was written behind our back.
    await expect(fs.stat(join(root, 'projects', 'index.md'))).rejects.toThrow();
  });

  it('regenerates and commits indexes once the tree settles', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await settle(readme);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.indexesDeferred).toBe(false);
    expect(report.regeneratedTrees).toEqual(['projects']);
    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      'indexes: sync',
    ]);

    // The index commit lands after the item exists, so its bullets resolve.
    const tracked = await git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
    expect(tracked).toContain('projects/index.md');
    expect(tracked).toContain('projects/2026-07/2026-07-10-alpha/README.md');
  });

  it('does not let an unresolved path defer the indexes forever', async () => {
    // `projects/stray.md` never becomes eligible, so gating on *any* skip
    // would wedge index regeneration permanently.
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    const stray = join(root, 'projects', 'stray.md');
    await fs.writeFile(stray, 'orphan\n');
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await settle(readme, stray);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.indexesDeferred).toBe(false);
    expect(report.regeneratedTrees).toEqual(['projects']);
    expect(report.skipped).toEqual([{ path: 'projects/stray.md', reason: 'unresolved' }]);
    expect(report.commits.map((c) => c.subject)).toContain('indexes: sync');
  });

  it('sweeps root structural files into a meta commit, ordered after items and before indexes', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    const agents = join(root, 'AGENTS.md');
    await fs.writeFile(agents, '# AGENTS\n');
    const gitignore = join(root, '.gitignore');
    await fs.appendFile(gitignore, 'extra-line\n');
    await settle(readme, agents, gitignore);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      'meta: sync',
      'indexes: sync',
    ]);
    // HEAD is the index commit; the meta commit sits one behind it.
    const metaFiles = await git(root, 'show', '--name-only', '--format=', 'HEAD~1');
    expect(metaFiles.trim().split('\n').sort()).toEqual(['.gitignore', 'AGENTS.md']);
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
  });

  it('sweeps every tracked non-tree file into meta, but never a gitignored view', async () => {
    // The catch-all: config files and durable subtrees get a committer too, so
    // nothing the single-writer rule forbids is left stranded. Gitignored views
    // are excluded upstream by git status, not by classification.
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    const agents = join(root, 'AGENTS.md');
    await fs.writeFile(agents, '# AGENTS\n');
    const opencode = join(root, 'opencode.json');
    await fs.writeFile(opencode, '{}\n');
    await fs.mkdir(join(root, 'resources', 'reference'), { recursive: true });
    const spec = join(root, 'resources', 'reference', 'spec.md');
    await fs.writeFile(spec, '# spec\n');
    // A generated view, gitignored → must never be swept.
    const gitignore = join(root, '.gitignore');
    await fs.appendFile(gitignore, 'CLAUDE.md\n');
    await fs.writeFile(join(root, 'CLAUDE.md'), '# generated\n');
    await settle(readme, agents, opencode, spec, gitignore);

    const report = await syncRun(root, RUN_DEFAULTS);

    const meta = report.commits.find((c) => c.subject === 'meta: sync');
    expect(meta?.paths).toEqual([
      '.gitignore',
      'AGENTS.md',
      'opencode.json',
      'resources/reference/spec.md',
    ]);
    // CLAUDE.md is gitignored — never classified, never committed, still on disk.
    const tracked = await git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
    expect(tracked).not.toContain('CLAUDE.md');
    await expect(fs.stat(join(root, 'CLAUDE.md'))).resolves.toBeTruthy();
  });

  it('does not let a mid-write meta file defer the indexes', async () => {
    // A `meta` path (AGENTS.md, .agents/**) is never referenced by a regenerated
    // index, so — unlike a mid-write item — it must not hold index regeneration
    // back. It just waits for the next tick like any quiet-period skip.
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await fs.writeFile(join(root, 'AGENTS.md'), '# AGENTS\n'); // fresh: inside the quiet period
    await settle(readme); // the item is settled; AGENTS.md is not

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.indexesDeferred).toBe(false);
    expect(report.regeneratedTrees).toEqual(['projects']);
    expect(report.skipped).toEqual([{ path: 'AGENTS.md', reason: 'quiet-period' }]);
    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      'indexes: sync',
    ]);
    // AGENTS.md was left for the next tick, not committed.
    expect(await git(root, 'status', '--porcelain')).toContain('AGENTS.md');
  });

  it('commits a deletion even inside the quiet period (no mtime to compare)', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);
    await syncRun(root, RUN_DEFAULTS);

    await fs.rm(readme);
    const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 3600 });

    expect(report.commits.map((c) => c.subject)).toEqual(['2026-07-10-alpha: sync']);
    expect(report.skipped).toEqual([]);
  });

  it('reports in-tree paths it cannot resolve to an item, and never commits them', async () => {
    const stray = join(root, 'projects', 'stray.md');
    await fs.writeFile(stray, 'orphan\n');
    await settle(stray);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.commits).toEqual([]);
    expect(report.skipped).toEqual([{ path: 'projects/stray.md', reason: 'unresolved' }]);
    expect(await subjects(root)).toEqual(['init']);
  });

  it('never sweeps a gitignored scratch path into an item commit', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    const localDir = join(root, 'projects', '2026-07', '2026-07-10-alpha', 'local');
    await fs.mkdir(localDir);
    const scratch = join(localDir, 'render.png');
    await fs.writeFile(scratch, 'binary-ish\n');
    await settle(readme, scratch);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.commits).toHaveLength(1);
    expect(report.commits[0].paths).toEqual(['projects/2026-07/2026-07-10-alpha/README.md']);
  });

  it('writes nothing under --dry-run but reports the plan', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);

    const report = await syncRun(root, { ...RUN_DEFAULTS, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.commits.map((c) => c.subject)).toEqual(['2026-07-10-alpha: sync']);
    expect(report.commits[0].sha).toBeNull();
    expect(await subjects(root)).toEqual(['init']);
  });

  it('does nothing and reports the holder when the lock is held', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);
    const gitDir = (await git(root, 'rev-parse', '--absolute-git-dir')).trim();
    await fs.writeFile(
      join(gitDir, 'condash-sync.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.locked).toBe(true);
    expect(report.heldBy?.pid).toBe(process.pid);
    expect(report.commits).toEqual([]);
    expect(await subjects(root)).toEqual(['init']);
  });

  it('releases the lock when the body throws', async () => {
    const gitDir = (await git(root, 'rev-parse', '--absolute-git-dir')).trim();
    await fs.writeFile(join(gitDir, 'MERGE_HEAD'), 'deadbeef\n');

    await expect(syncRun(root, RUN_DEFAULTS)).rejects.toThrow(SyncRefusedError);
    await expect(fs.stat(join(gitDir, 'condash-sync.lock'))).rejects.toThrow();
  });

  it('refuses a tree mid-merge', async () => {
    const gitDir = (await git(root, 'rev-parse', '--absolute-git-dir')).trim();
    await fs.writeFile(join(gitDir, 'MERGE_HEAD'), 'deadbeef\n');

    await expect(syncRun(root, RUN_DEFAULTS)).rejects.toThrow(/merge is in progress/);
  });

  it('refuses a conflicted tree', async () => {
    // Manufacture a real conflict: two branches touching one line.
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'alpha');
    await git(root, 'checkout', '-q', '-b', 'side');
    await fs.writeFile(readme, 'side\n');
    await git(root, 'commit', '-q', '-a', '-m', 'side');
    await git(root, 'checkout', '-q', 'main');
    await fs.writeFile(readme, 'main\n');
    await git(root, 'commit', '-q', '-a', '-m', 'main');
    await expect(git(root, 'merge', 'side')).rejects.toThrow();

    // A conflicted merge also leaves MERGE_HEAD, and that guard fires first.
    // Drop it so the `UU` index entries are the only thing left to catch —
    // which is the state a resolved-but-not-committed tree is really in.
    const gitDir = (await git(root, 'rev-parse', '--absolute-git-dir')).trim();
    await fs.rm(join(gitDir, 'MERGE_HEAD'));

    await expect(syncRun(root, RUN_DEFAULTS)).rejects.toThrow(/conflicted paths/);
  });

  it('pushes when the branch is ahead of its upstream', async () => {
    const remote = await fs.mkdtemp(join(tmpdir(), 'condash-sync-remote-'));
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-q', '-u', 'origin', 'main');

    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);

    const report = await syncRun(root, { ...RUN_DEFAULTS, push: true });

    expect(report.pushed).toBe(true);
    expect(report.pushError).toBeNull();
    expect(report.ahead).toBe(0);
    expect((await git(remote, 'log', '--format=%s', '-1')).trim()).toBe('2026-07-10-alpha: sync');

    await fs.rm(remote, { recursive: true, force: true });
  });

  it('reports a rejected push as a warning and keeps the commits local', async () => {
    const remote = await fs.mkdtemp(join(tmpdir(), 'condash-sync-remote-'));
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-q', '-u', 'origin', 'main');
    // Someone else moved the remote on: our push is now non-fast-forward.
    await fs.rm(remote, { recursive: true, force: true });

    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);

    const report = await syncRun(root, { ...RUN_DEFAULTS, push: true });

    expect(report.commits).toHaveLength(1);
    expect(report.pushed).toBe(false);
    expect(report.pushError).toBeTruthy();
    expect(await subjects(root)).toContain('2026-07-10-alpha: sync');
  });
});

describe('syncCommit', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeGitConception();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('commits one item under a real subject, ignoring the quiet period', async () => {
    await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await writeProjectReadme(root, 'beta', { date: '2026-07-11', kind: 'project' });

    const report = await syncCommit(
      root,
      'projects/2026-07/2026-07-10-alpha',
      'Close alpha: shipped v1.2.0',
      { dryRun: false, push: false },
    );

    expect(report.commits.map((c) => c.subject)).toEqual(['Close alpha: shipped v1.2.0']);
    expect(await subjects(root)).toEqual(['Close alpha: shipped v1.2.0', 'init']);
    // beta is untouched — still dirty.
    expect(await git(root, 'status', '--porcelain')).toContain('2026-07-11-beta');
  });

  it('refuses when the item has no changes', async () => {
    await expect(
      syncCommit(root, 'projects/2026-07/2026-07-10-alpha', 'nothing', {
        dryRun: false,
        push: false,
      }),
    ).rejects.toThrow(/No changes under/);
  });

  it('refuses when the sweeper holds the lock, rather than skipping silently', async () => {
    await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    const gitDir = (await git(root, 'rev-parse', '--absolute-git-dir')).trim();
    await fs.writeFile(
      join(gitDir, 'condash-sync.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    await expect(
      syncCommit(root, 'projects/2026-07/2026-07-10-alpha', 'x', { dryRun: false, push: false }),
    ).rejects.toThrow(/holds the lock/);
  });
});
