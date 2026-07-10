/**
 * CLI surface for the `sync` noun: flag validation, help, and one end-to-end
 * `--json` sweep against a real repo to pin the envelope shape. The sweeper's
 * behaviour itself is covered in `src/main/sync/run.test.ts`.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../../main/exec';
import type { SyncReport } from '../../main/sync/run';
import { CliError } from '../output';
import { UsageError, type ParsedArgs } from '../parser';
import { runSync } from './sync';
import {
  captureStdout,
  humanCtx,
  jsonCtx,
  parseJsonEnvelope,
  writeProjectReadme,
} from './test-helpers';

let savedGlobal: string | undefined;
let savedSystem: string | undefined;

beforeAll(() => {
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  savedSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
});

afterAll(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = savedSystem;
});

function args(verb: string | null, positional: string[] = [], flags: ParsedArgs['flags'] = {}) {
  return { noun: 'sync', verb, positional, flags };
}

async function makeGitConception(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'condash-sync-cli-'));
  await fs.mkdir(join(root, 'projects'), { recursive: true });
  await fs.mkdir(join(root, 'knowledge'), { recursive: true });
  await fs.writeFile(join(root, '.gitignore'), 'projects/.index-dirty\n');
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: root });
  await exec('git', ['add', '.gitignore'], { cwd: root });
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}

describe('runSync flag + usage validation', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'condash-sync-usage-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects an unknown verb', async () => {
    const { threw } = await captureStdout(() => runSync('sweep', args('sweep'), humanCtx(), root));
    expect((threw as CliError).exitCode).toBe(2);
    expect((threw as CliError).message).toContain('Unknown sync verb: sweep');
  });

  it('rejects an unknown flag with a suggestion', async () => {
    const { threw } = await captureStdout(() =>
      runSync('run', args('run', [], { 'dry-runn': true }), humanCtx(), root),
    );
    expect(threw).toBeInstanceOf(UsageError);
    expect((threw as UsageError).message).toContain('did you mean --dry-run?');
  });

  it('rejects a non-numeric quiet period', async () => {
    const { threw } = await captureStdout(() =>
      runSync('run', args('run', [], { 'quiet-period': 'soon' }), humanCtx(), root),
    );
    expect(threw).toBeInstanceOf(UsageError);
    expect((threw as UsageError).message).toContain('--quiet-period');
  });

  it('requires an item for commit', async () => {
    const { threw } = await captureStdout(() =>
      runSync('commit', args('commit', [], { message: 'x' }), humanCtx(), root),
    );
    expect((threw as CliError).exitCode).toBe(2);
    expect((threw as CliError).message).toContain('condash sync commit <item>');
  });

  it('requires a non-empty message for commit', async () => {
    const { threw } = await captureStdout(() =>
      runSync('commit', args('commit', ['alpha'], { message: '   ' }), humanCtx(), root),
    );
    expect((threw as CliError).exitCode).toBe(2);
    expect((threw as CliError).message).toContain('--message is required');
  });

  it('resolves the item slug, surfacing NOT_FOUND for an unknown one', async () => {
    const { threw } = await captureStdout(() =>
      runSync('commit', args('commit', ['nope'], { message: 'x' }), humanCtx(), root),
    );
    expect((threw as CliError).exitCode).toBe(4);
  });
});

describe('runSync help', () => {
  it('prints an overview with a Verbs block when no verb is given', async () => {
    const { stdout } = await captureStdout(() => runSync(null, args(null), humanCtx(), '', true));
    expect(stdout).toContain('Verbs:');
    expect(stdout).toContain('  run');
    expect(stdout).toContain('  commit');
  });

  it('prints per-verb help', async () => {
    const { stdout } = await captureStdout(() => runSync('run', args('run'), humanCtx(), '', true));
    expect(stdout).toContain('--quiet-period');
    expect(stdout).toContain('exits 0 without doing anything');
  });
});

describe('runSync run against a real repo', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeGitConception();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('defaults to the run verb and emits a report envelope', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    const hourAgo = new Date(Date.now() - 3_600_000);
    await fs.utimes(readme, hourAgo, hourAgo);

    // verb === null on the dispatch path means `run`.
    const { stdout, threw } = await captureStdout(() =>
      runSync(null, args(null, [], { 'no-push': true }), jsonCtx(), root),
    );
    expect(threw).toBeUndefined();

    const report = parseJsonEnvelope<SyncReport>(stdout).data as SyncReport;
    expect(report.locked).toBe(false);
    expect(report.commits.map((c) => c.subject)).toEqual(['2026-07-10-alpha: sync']);
    expect(report.pushed).toBe(false);
  });

  it('says so in human mode when there is nothing to sync', async () => {
    const { stdout } = await captureStdout(() =>
      runSync('run', args('run', [], { 'no-push': true }), humanCtx(), root),
    );
    expect(stdout).toBe('nothing to sync\n');
  });

  it('prints nothing and exits cleanly when the lock is held', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    const hourAgo = new Date(Date.now() - 3_600_000);
    await fs.utimes(readme, hourAgo, hourAgo);
    await fs.writeFile(
      join(root, '.git', 'condash-sync.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const { stdout, threw } = await captureStdout(() =>
      runSync('run', args('run', [], { 'no-push': true }), humanCtx(), root),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toBe('');
  });

  it('refuses a mid-merge tree with a validation exit code', async () => {
    await fs.writeFile(join(root, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    const { threw } = await captureStdout(() =>
      runSync('run', args('run', [], { 'no-push': true }), humanCtx(), root),
    );
    expect((threw as CliError).exitCode).toBe(3);
    expect((threw as CliError).message).toContain('merge is in progress');
  });

  it('commits one item under a real subject via the commit verb', async () => {
    await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });

    const { threw } = await captureStdout(() =>
      runSync(
        'commit',
        args('commit', ['alpha'], { message: 'Open alpha', 'no-push': true }),
        jsonCtx(),
        root,
      ),
    );
    expect(threw).toBeUndefined();

    const { stdout } = await exec('git', ['log', '--format=%s'], { cwd: root });
    expect(stdout.trim().split('\n')).toEqual(['Open alpha', 'init']);
  });
});
