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

const RUN_DEFAULTS = {
  dryRun: false,
  push: false,
  quietPeriodSeconds: 90,
  integration: 'ff-only' as const,
};

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

/**
 * Simulate a second session advancing the shared remote: clone the bare
 * remote, commit a file under a local identity, and push. Returns the sha
 * the second session pushed.
 */
async function advanceRemote(remote: string, root: string): Promise<string> {
  const clone = await fs.mkdtemp(join(tmpdir(), 'condash-sync-second-'));
  try {
    await git(root, 'clone', '-q', remote, clone);
    await git(clone, 'config', 'user.email', 'test@example.com');
    await git(clone, 'config', 'user.name', 'Test');
    const file = join(clone, 'advance-remote.txt');
    await fs.writeFile(file, 'advanced by a second session\n');
    await git(clone, 'add', file);
    await git(clone, 'commit', '-q', '-m', 'advance remote');
    await git(clone, 'push', '-q', 'origin', 'main');
    return (await git(clone, 'rev-parse', 'HEAD')).trim();
  } finally {
    await fs.rm(clone, { recursive: true, force: true });
  }
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
    // projects via its marker; knowledge because the sweep commits content in
    // it — a tree's indexes regenerate whenever what they describe commits.
    expect(report.regeneratedTrees).toEqual(['projects', 'knowledge']);
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

  it('leaves a hand-run index.md rewrite inside the quiet period for the next tick', async () => {
    // First sweep commits an item and its regenerated index, giving HEAD a
    // settled baseline.
    const readme = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
    });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await settle(readme);
    await syncRun(root, RUN_DEFAULTS);

    // An agent runs `condash knowledge index` by hand right now — the index
    // path used to bypass the quiet period entirely and would be swept into a
    // commit mid-write.
    const index = join(root, 'projects', 'index.md');
    await fs.writeFile(index, '# projects\n\n- hand edit\n');
    const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 3600 });

    expect(report.commits).toEqual([]);
    expect(report.skipped).toEqual([{ path: 'projects/index.md', reason: 'quiet-period' }]);
    expect(await git(root, 'status', '--porcelain')).toContain('M projects/index.md');

    // Settled, the next tick commits it as ordinary index work.
    await settle(index);
    const second = await syncRun(root, RUN_DEFAULTS);
    expect(second.commits.map((c) => c.subject)).toEqual(['indexes: sync']);
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
    expect(report.deferredIndexPaths).toEqual(['projects/2026-07/2026-07-10-alpha/README.md']);
    expect(report.regeneratedTrees).toEqual([]);
    expect(report.commits).toEqual([]);
    expect(await subjects(root)).toEqual(['init']);
    // Marker intact, so the next settled tick regenerates.
    await expect(fs.stat(join(root, 'projects', '.index-dirty'))).resolves.toBeTruthy();
    // And no index.md was written behind our back.
    await expect(fs.stat(join(root, 'projects', 'index.md'))).rejects.toThrow();
  });

  it('defers only the tree that is mid-write, and commits the other tree', async () => {
    // Regression (condash#508): gating both trees on *any* unsettled path
    // starved the index bucket. A mid-write project item must not hold back a
    // knowledge restructure whose body files are already settled, or the
    // remote keeps moved files with no index.md pointing at them.
    await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' }); // fresh
    const body = join(root, 'knowledge', 'topics', 'settled.md');
    await fs.mkdir(join(root, 'knowledge', 'topics'), { recursive: true });
    await fs.writeFile(body, '# Settled\n\nBody.\n');
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await fs.writeFile(join(root, 'knowledge', '.index-dirty'), '');
    await settle(body);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.indexesDeferred).toBe(true);
    expect(report.deferredIndexTrees).toEqual(['projects']);
    expect(report.regeneratedTrees).toEqual(['knowledge']);
    expect(report.commits.map((c) => c.subject)).toEqual(['knowledge: sync', 'indexes: sync']);

    // The knowledge indexes landed; the projects ones did not, and their
    // marker survives for the next tick.
    const indexCommit = report.commits.find((c) => c.subject === 'indexes: sync');
    expect(indexCommit?.paths).toEqual(['knowledge/index.md', 'knowledge/topics/index.md']);
    await expect(fs.stat(join(root, 'projects', '.index-dirty'))).resolves.toBeTruthy();
    await expect(fs.stat(join(root, 'knowledge', '.index-dirty'))).rejects.toThrow();
    const tracked = await git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
    expect(tracked).not.toContain('projects/index.md');
  });

  it('holds back an already-written index.md of a deferred tree', async () => {
    // The marker is not the only way index.md files go pending: an agent that
    // ran `condash knowledge index` by hand rewrote them and cleared the
    // marker. Those still belong to the deferred tree.
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await fs.mkdir(join(root, 'knowledge', 'topics'), { recursive: true });
    const body = join(root, 'knowledge', 'topics', 'fresh.md'); // mid-write knowledge path
    await fs.writeFile(body, '# Fresh\n');
    const knowledgeIndex = join(root, 'knowledge', 'index.md');
    await fs.writeFile(knowledgeIndex, '# knowledge\n\n- [`topics/`](topics/index.md)\n');
    await settle(readme, knowledgeIndex);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.deferredIndexTrees).toEqual(['knowledge']);
    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      'indexes: sync',
    ]);
    // The index commit carries the projects indexes alone (alpha's commit
    // regenerated its own tree); the knowledge one is still uncommitted,
    // waiting for the tick that finds knowledge/ settled.
    const indexCommit = report.commits.find((c) => c.subject === 'indexes: sync');
    expect(indexCommit?.paths.every((path) => path.startsWith('projects/'))).toBe(true);
    expect(await git(root, 'status', '--porcelain', '-uall')).toContain('knowledge/index.md');
    const tracked = await git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
    expect(tracked).not.toContain('knowledge/index.md');
  });

  it('does not report a deferral when the mid-write tree has no index work', async () => {
    // An unsettled item with no marker and no pending index.md is holding
    // nothing up — reporting it as deferred would make a clean sweep look
    // like a stalled one.
    await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });

    const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 3600 });

    expect(report.indexesDeferred).toBe(false);
    expect(report.deferredIndexTrees).toEqual([]);
    expect(report.skipped).toHaveLength(1);
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

  it('regenerates over a tracked item that is mid-write, then re-derives once it settles', async () => {
    // Regression (condash#527): within one tree, continuous writing kept the
    // indexes deferred for as long as the churn lasted. A tracked file can't
    // produce a dangling bullet, so its tree regenerates anyway; the bullet
    // may describe mid-write text for one tick, and the marker is kept so the
    // next tick re-derives it from the settled file.
    const alpha = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
      body: '## Goal\n\nThe first version of the goal.\n',
    });
    const beta = await writeProjectReadme(root, 'beta', {
      date: '2026-07-11',
      kind: 'project',
      status: 'now',
    });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await settle(alpha, beta);
    await syncRun(root, RUN_DEFAULTS);
    await expect(fs.stat(join(root, 'projects', '.index-dirty'))).rejects.toThrow();

    // Tick 1: beta closes (settled, marker set) while alpha is being rewritten
    // — its status flips to `review` mid-edit. For an item folder the engine
    // re-derives the tag block of an existing bullet (kind, status, apps) and
    // leaves its description alone, so the tags are the transient to watch.
    await writeProjectReadme(root, 'beta', { date: '2026-07-11', kind: 'project', status: 'done' });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await settle(beta);
    await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'review',
      body: '## Goal\n\nThe first version of the goal.\n',
    });

    const tick1 = await syncRun(root, RUN_DEFAULTS);

    expect(tick1.indexesDeferred).toBe(false);
    expect(tick1.deferredIndexPaths).toEqual([]);
    expect(tick1.skipped).toEqual([
      { path: 'projects/2026-07/2026-07-10-alpha/README.md', reason: 'quiet-period' },
    ]);
    expect(tick1.regeneratedTrees).toEqual(['projects']);
    expect(tick1.commits.map((c) => c.subject)).toEqual(['2026-07-11-beta: sync', 'indexes: sync']);
    // beta's close reached main in the same tick; alpha's tag block is the
    // one-tick transient, drawn from the mid-write header.
    const month1 = await git(root, 'show', 'HEAD:projects/2026-07/index.md');
    expect(month1).toMatch(/2026-07-11-beta.*\[project, done\]/);
    expect(month1).toMatch(/2026-07-10-alpha.*\[project, review\]/);
    // The marker survives precisely because alpha was unsettled.
    await expect(fs.stat(join(root, 'projects', '.index-dirty'))).resolves.toBeTruthy();

    // Tick 2: alpha's edit ends on `done` and settles. No CLI mutation touched
    // the marker in between — the kept marker is what brings the bullet back
    // in line.
    await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'done',
      body: '## Goal\n\nThe first version of the goal.\n',
    });
    await settle(alpha);

    const tick2 = await syncRun(root, RUN_DEFAULTS);

    expect(tick2.regeneratedTrees).toEqual(['projects']);
    expect(tick2.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      'indexes: sync',
    ]);
    const month2 = await git(root, 'show', 'HEAD:projects/2026-07/index.md');
    expect(month2).toMatch(/2026-07-10-alpha.*\[project, done\]/);
    expect(month2).not.toContain('[project, review]');
    // Nothing was unsettled this time, so the marker clears.
    await expect(fs.stat(join(root, 'projects', '.index-dirty'))).rejects.toThrow();
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
  });

  it('still defers for a new-to-HEAD path mid-write, and names it, while a tracked one does not', async () => {
    const alpha = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await settle(alpha);
    await syncRun(root, RUN_DEFAULTS);

    // alpha (tracked) and gamma (never committed) are both mid-write.
    await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project', status: 'now' });
    await writeProjectReadme(root, 'gamma', { date: '2026-07-12', kind: 'project' });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.indexesDeferred).toBe(true);
    expect(report.deferredIndexTrees).toEqual(['projects']);
    // Only gamma is named: it is the one that would dangle.
    expect(report.deferredIndexPaths).toEqual(['projects/2026-07/2026-07-12-gamma/README.md']);
    expect(report.regeneratedTrees).toEqual([]);
    expect(report.commits).toEqual([]);
    await expect(fs.stat(join(root, 'projects', '.index-dirty'))).resolves.toBeTruthy();
    const tracked = await git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
    expect(tracked).not.toContain('2026-07-12-gamma');
  });

  it('keeps the marker when a mid-write file is reverted before it ever settles', async () => {
    // The one path that "content commits re-dirty" cannot cover: a file
    // rewritten, regenerated over, then put back to its HEAD text — git no
    // longer lists it, so no commit re-dirties the tree. The marker kept at
    // regeneration time is what repairs the bullet.
    const alpha = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
    });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await settle(alpha);
    await syncRun(root, RUN_DEFAULTS);

    await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'done',
    });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    const tick1 = await syncRun(root, RUN_DEFAULTS);
    expect(tick1.regeneratedTrees).toEqual(['projects']);
    expect(await git(root, 'show', 'HEAD:projects/2026-07/index.md')).toMatch(
      /2026-07-10-alpha.*\[project, done\]/,
    );

    // Reverted: content equals HEAD, so git status is silent about alpha.
    await git(root, 'checkout', '--', 'projects/2026-07/2026-07-10-alpha/README.md');
    const tick2 = await syncRun(root, RUN_DEFAULTS);

    expect(tick2.skipped).toEqual([]);
    expect(tick2.regeneratedTrees).toEqual(['projects']);
    expect(tick2.commits.map((c) => c.subject)).toEqual(['indexes: sync']);
    expect(await git(root, 'show', 'HEAD:projects/2026-07/index.md')).toMatch(
      /2026-07-10-alpha.*\[project, now\]/,
    );
    await expect(fs.stat(join(root, 'projects', '.index-dirty'))).rejects.toThrow();
  });

  it('regenerates a tree whose content it commits, even with the marker clear', async () => {
    // A hand edit of a README header touches no marker; the index used to stay
    // stale until the next CLI mutation anywhere in the tree.
    const alpha = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
    });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await settle(alpha);
    await syncRun(root, RUN_DEFAULTS);
    await expect(fs.stat(join(root, 'projects', '.index-dirty'))).rejects.toThrow();

    await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'done',
    });
    await settle(alpha);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.regeneratedTrees).toEqual(['projects']);
    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      'indexes: sync',
    ]);
    expect(await git(root, 'show', 'HEAD:projects/2026-07/index.md')).toMatch(
      /2026-07-10-alpha.*\[project, done\]/,
    );
  });

  it('drops the bullet of a deleted item in the tick that commits the deletion', async () => {
    const alpha = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    const beta = await writeProjectReadme(root, 'beta', { date: '2026-07-11', kind: 'project' });
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');
    await settle(alpha, beta);
    await syncRun(root, RUN_DEFAULTS);
    expect(await git(root, 'show', 'HEAD:projects/2026-07/index.md')).toContain('2026-07-11-beta');

    await fs.rm(join(root, 'projects', '2026-07', '2026-07-11-beta'), { recursive: true });

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-11-beta: sync',
      'indexes: sync',
    ]);
    expect(await git(root, 'show', 'HEAD:projects/2026-07/index.md')).not.toContain(
      '2026-07-11-beta',
    );
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

  it('synthesizes a Close milestone subject when a sweep introduces the Closed. entry', async () => {
    const readme = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
      body: '## Timeline\n\n- 2026-07-10 — Opened.',
    });
    await settle(readme);
    await syncRun(root, RUN_DEFAULTS);

    // The write-files-only close ritual: status flip + Closed. timeline entry.
    await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'done',
      body: [
        '## Timeline',
        '',
        '- 2026-07-10 — Opened.',
        '- 2026-07-12 — Closed. Did the thing.',
        '- 2026-07-12 — Checked knowledge promotion',
      ].join('\n'),
    });
    await settle(readme);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.commits.map((c) => c.subject)).toEqual([
      'Close 2026-07-10-alpha. Outcome: Did the thing.',
      'indexes: sync',
    ]);
    expect((await git(root, 'log', '--format=%s', '-2')).trim().split('\n')).toContain(
      'Close 2026-07-10-alpha. Outcome: Did the thing.',
    );
  });

  it('reverts to the plain sync subject once the close is already committed', async () => {
    const readme = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'done',
      body: ['## Timeline', '', '- 2026-07-12 — Closed. Did the thing.'].join('\n'),
    });
    await settle(readme);
    await syncRun(root, RUN_DEFAULTS);

    // A later edit with no new Closed. entry is an ordinary sweep again.
    await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'done',
      body: [
        '## Timeline',
        '',
        '- 2026-07-12 — Closed. Did the thing.',
        '- 2026-07-12 — Edited after close.',
      ].join('\n'),
    });
    await settle(readme);

    const report = await syncRun(root, RUN_DEFAULTS);

    expect(report.commits.map((c) => c.subject)).toEqual(['2026-07-10-alpha: sync']);
  });

  it('commits a deletion even inside the quiet period (no mtime to compare)', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);
    await syncRun(root, RUN_DEFAULTS);

    await fs.rm(readme);
    const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 3600 });

    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      'indexes: sync',
    ]);
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

    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      'indexes: sync',
    ]);
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
    expect((await git(remote, 'log', '--format=%s')).trim().split('\n')).toContain(
      '2026-07-10-alpha: sync',
    );

    await fs.rm(remote, { recursive: true, force: true });
  });

  it('fast-forwards a remote-only lead before committing, keeping the push a fast-forward', async () => {
    const remote = await fs.mkdtemp(join(tmpdir(), 'condash-sync-remote-'));
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-q', '-u', 'origin', 'main');

    // A second session advances the remote while the root stays stale.
    const remoteSha = await advanceRemote(remote, root);

    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);

    const report = await syncRun(root, { ...RUN_DEFAULTS, push: true });

    expect(report.pushed).toBe(true);
    expect(report.diverged).toBe(false);
    expect(report.integrateError).toBeNull();
    expect(report.behind).toBe(0);
    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      'indexes: sync',
    ]);

    // The remote's commit is now part of the root's history…
    await expect(git(root, 'merge-base', '--is-ancestor', remoteSha, 'HEAD')).resolves.toBe('');
    // …and the push reached the remote.
    expect((await git(remote, 'log', '--format=%s')).trim().split('\n')).toContain(
      '2026-07-10-alpha: sync',
    );

    await fs.rm(remote, { recursive: true, force: true });
  });

  it('refuses to push on a genuine divergence, keeping the local commits', async () => {
    const remote = await fs.mkdtemp(join(tmpdir(), 'condash-sync-remote-'));
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-q', '-u', 'origin', 'main');

    // A local lead the remote does not have yet.
    const lead = await writeProjectReadme(root, 'lead', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
    });
    await settle(lead);
    await syncRun(root, { ...RUN_DEFAULTS, push: false });

    // A second session advances the remote.
    await advanceRemote(remote, root);

    // The sweep finds another settled change on top of the lead.
    const next = await writeProjectReadme(root, 'next', {
      date: '2026-07-11',
      kind: 'project',
      status: 'now',
    });
    await settle(next);

    const report = await syncRun(root, { ...RUN_DEFAULTS, push: true });

    expect(report.commits.length).toBeGreaterThanOrEqual(1);
    expect(report.pushed).toBe(false);
    expect(report.diverged).toBe(true);
    expect(report.behind).toBeGreaterThanOrEqual(1);
    expect(report.ahead).toBeGreaterThanOrEqual(1);
    expect(report.integrateError).toBeNull();
    expect(report.pushError).toBeNull();

    await fs.rm(remote, { recursive: true, force: true });
  });

  it('commits the local edit even when the fast-forward is blocked by a dirty collision', async () => {
    const remote = await fs.mkdtemp(join(tmpdir(), 'condash-sync-remote-'));
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-q', '-u', 'origin', 'main');

    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'alpha');
    await git(root, 'push', '-q', 'origin', 'main');

    // A second session edits the same README and pushes.
    const clone = await fs.mkdtemp(join(tmpdir(), 'condash-sync-second-'));
    try {
      await git(root, 'clone', '-q', remote, clone);
      await git(clone, 'config', 'user.email', 'test@example.com');
      await git(clone, 'config', 'user.name', 'Test');
      const relReadme = 'projects/2026-07/2026-07-10-alpha/README.md';
      await fs.writeFile(join(clone, relReadme), 'remote edit\n');
      await git(clone, 'add', '.');
      await git(clone, 'commit', '-q', '-m', 'remote edit');
      await git(clone, 'push', '-q', 'origin', 'main');
    } finally {
      await fs.rm(clone, { recursive: true, force: true });
    }

    // The root edits the same file, uncommitted.
    await fs.writeFile(readme, 'local edit\n');
    await settle(readme);

    const report = await syncRun(root, { ...RUN_DEFAULTS, push: true });

    expect(report.integrateError).toBeTruthy();
    expect(report.integrateError).toMatch(/fast-forward/i);
    expect(report.pushed).toBe(false);
    expect(report.diverged).toBe(false);
    expect(report.commits.length).toBeGreaterThanOrEqual(1);
    // The local edit was still swept into a commit.
    expect(await git(root, 'status', '--porcelain')).toBe('');

    await fs.rm(remote, { recursive: true, force: true });
  });

  it('reports a failed fetch as a non-fatal integrate error and still commits', async () => {
    const remote = await fs.mkdtemp(join(tmpdir(), 'condash-sync-remote-'));
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-q', '-u', 'origin', 'main');
    // Someone else moved the remote on: our fetch now fails.
    await fs.rm(remote, { recursive: true, force: true });

    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);

    const report = await syncRun(root, { ...RUN_DEFAULTS, push: true });

    expect(report.commits).toHaveLength(2);
    expect(report.pushed).toBe(false);
    expect(report.pushError).toBeNull();
    expect(report.integrateError).toBeTruthy();
    expect(report.integrateError).toMatch(/fetch failed/i);
    expect(await subjects(root)).toContain('2026-07-10-alpha: sync');
  });

  it('reports a null behind when there is no upstream, without an integrate error', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);

    const report = await syncRun(root, { ...RUN_DEFAULTS, push: true });

    expect(report.commits).toHaveLength(2);
    expect(report.ahead).toBeNull();
    expect(report.behind).toBeNull();
    expect(report.diverged).toBe(false);
    expect(report.integrateError).toBeNull();
    expect(report.pushed).toBe(false);
    expect(await subjects(root)).toContain('2026-07-10-alpha: sync');
  });

  it('reports legacy fields under --dry-run even with push requested', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);

    const report = await syncRun(root, { ...RUN_DEFAULTS, dryRun: true, push: true });

    expect(report.dryRun).toBe(true);
    expect(report.commits.map((c) => c.subject)).toEqual(['2026-07-10-alpha: sync']);
    expect(report.commits[0].sha).toBeNull();
    expect(report.ahead).toBeNull();
    expect(report.behind).toBeNull();
    expect(report.diverged).toBe(false);
    expect(report.integrateError).toBeNull();
    expect(report.pushed).toBe(false);
    expect(await subjects(root)).toEqual(['init']);
  });

  it("honors integration: 'off' as legacy behavior — no fetch, the push fails instead", async () => {
    const remote = await fs.mkdtemp(join(tmpdir(), 'condash-sync-remote-'));
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-q', '-u', 'origin', 'main');
    // The remote is gone, exactly as in the fetch-failure test — but with the
    // integration off, the sweep never fetches, so the missing remote surfaces
    // as a rejected push instead of an integrate error. This is the crisp
    // differentiator: 'ff-only' yields integrateError, 'off' yields pushError.
    await fs.rm(remote, { recursive: true, force: true });

    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);

    const report = await syncRun(root, { ...RUN_DEFAULTS, push: true, integration: 'off' });

    expect(report.integrateError).toBeNull();
    expect(report.behind).toBeNull();
    expect(report.diverged).toBe(false);
    expect(report.pushed).toBe(false);
    expect(report.pushError).toBeTruthy();
    expect(report.commits).toHaveLength(2);
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
      { dryRun: false, push: false, integration: 'ff-only' },
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
        integration: 'ff-only',
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
      syncCommit(root, 'projects/2026-07/2026-07-10-alpha', 'x', {
        dryRun: false,
        push: false,
        integration: 'ff-only',
      }),
    ).rejects.toThrow(/holds the lock/);
  });

  it('commits the item under a real subject but refuses to push on divergence', async () => {
    const remote = await fs.mkdtemp(join(tmpdir(), 'condash-sync-remote-'));
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-q', '-u', 'origin', 'main');

    // A local lead the remote does not have yet.
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);
    await syncRun(root, { ...RUN_DEFAULTS, push: false });

    // A second session advances the remote.
    await advanceRemote(remote, root);

    // A new settled change under the item, committed via syncCommit.
    await fs.appendFile(readme, '# more\n');
    await settle(readme);

    const report = await syncCommit(
      root,
      'projects/2026-07/2026-07-10-alpha',
      'Close alpha: shipped v1.2.0',
      { dryRun: false, push: true, integration: 'ff-only' },
    );

    expect(report.commits.map((c) => c.subject)).toEqual(['Close alpha: shipped v1.2.0']);
    expect(report.diverged).toBe(true);
    expect(report.pushed).toBe(false);
    expect(report.behind).toBeGreaterThanOrEqual(1);
    expect(report.ahead).toBeGreaterThanOrEqual(1);
    expect(report.integrateError).toBeNull();
    expect(await subjects(root)).toEqual([
      'Close alpha: shipped v1.2.0',
      'indexes: sync',
      '2026-07-10-alpha: sync',
      'init',
    ]);

    await fs.rm(remote, { recursive: true, force: true });
  });
});
