/**
 * Tests for `condash worktrees`: dispatch, USAGE shapes, and the no-repo
 * smoke-path of `check` / `mismatch`. Verbs that mutate git state
 * (setup / remove) stay covered by integration tests on real repos —
 * here we only assert the CLI surface (flag parsing, missing-arg errors).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorktrees } from './worktrees';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
  writeProjectReadme,
} from './test-helpers';
import { CliError } from '../output';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
});

afterEach(async () => {
  await rmConception(conceptionPath);
});

describe('runWorktrees dispatch', () => {
  it('rejects an unknown verb with USAGE', async () => {
    const { threw } = await captureStdout(() =>
      runWorktrees(
        'banana',
        { noun: 'worktrees', verb: 'banana', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('prints help when verb is null', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runWorktrees(
        null,
        { noun: 'worktrees', verb: '', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash worktrees/);
  });

  it('--help short-circuits to help text', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runWorktrees(
        'check',
        { noun: 'worktrees', verb: 'check', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
        true,
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash worktrees check/);
  });
});

describe('worktrees check', () => {
  it('USAGE error when branch positional is missing', async () => {
    const { threw } = await captureStdout(() =>
      runWorktrees(
        'check',
        { noun: 'worktrees', verb: 'check', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('returns an empty declaringItems list when no project declares the branch', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runWorktrees(
        'check',
        { noun: 'worktrees', verb: 'check', positional: ['nope-branch'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{
      branch: string;
      declaringItems: unknown[];
      repos: unknown[];
    }>(stdout).data!;
    expect(data.branch).toBe('nope-branch');
    expect(data.declaringItems).toEqual([]);
    expect(data.repos).toEqual([]);
  });

  it('surfaces the declaring project when a README references the branch', async () => {
    await writeProjectReadme(conceptionPath, 'wt-test', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      apps: ['condash'],
      branch: 'review/wt-test',
      title: 'Worktree test project',
    });
    const { stdout } = await captureStdout(() =>
      runWorktrees(
        'check',
        { noun: 'worktrees', verb: 'check', positional: ['review/wt-test'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const data = parseJsonEnvelope<{
      declaringItems: Array<{ slug: string; status: string; apps: string[] }>;
    }>(stdout).data!;
    expect(data.declaringItems.length).toBe(1);
    expect(data.declaringItems[0].apps).toEqual(['condash']);
  });
});

describe('worktrees setup / remove — surface', () => {
  it('setup USAGE when branch positional is missing', async () => {
    const { threw } = await captureStdout(() =>
      runWorktrees(
        'setup',
        { noun: 'worktrees', verb: 'setup', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('remove USAGE when branch positional is missing', async () => {
    const { threw } = await captureStdout(() =>
      runWorktrees(
        'remove',
        { noun: 'worktrees', verb: 'remove', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('setup exits RUNTIME (1) when an install command fails, after emitting the result', async () => {
    // Real repo so `git worktree add` succeeds; the install command fails.
    const { exec } = await import('../../main/exec');
    const { promises: fs } = await import('node:fs');
    const { join } = await import('node:path');
    const workspace = join(conceptionPath, 'workspace');
    const worktreesRoot = join(conceptionPath, 'wt');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(worktreesRoot, { recursive: true });
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    await exec('git', ['init', '-q', '-b', 'main', 'demo'], { cwd: workspace, env: gitEnv });
    const repo = join(workspace, 'demo');
    await exec('git', ['config', 'user.email', 't@example.com'], { cwd: repo, env: gitEnv });
    await exec('git', ['config', 'user.name', 'T'], { cwd: repo, env: gitEnv });
    await exec('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
      cwd: repo,
      env: gitEnv,
    });
    await fs.writeFile(
      join(conceptionPath, 'condash.json'),
      JSON.stringify({
        workspace_path: workspace,
        worktrees_path: worktreesRoot,
        repositories: [{ name: 'demo', install: 'echo broken >&2; exit 9' }],
      }),
      'utf8',
    );

    const { stdout, threw } = await captureStdout(() =>
      runWorktrees(
        'setup',
        {
          noun: 'worktrees',
          verb: 'setup',
          positional: ['cli-exit-test'],
          flags: { repo: 'demo' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    // The result was still emitted (data on stdout)…
    const data = parseJsonEnvelope<{
      installRan: Array<{ ok: boolean; stderrTail?: string }>;
    }>(stdout).data!;
    expect(data.installRan).toHaveLength(1);
    expect(data.installRan[0].ok).toBe(false);
    expect(data.installRan[0].stderrTail).toContain('broken');
    // …and the command signals RUNTIME so scripts can react.
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(1);
  });
});

describe('worktrees mismatch', () => {
  it('returns an empty issues list on a fresh conception', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runWorktrees(
        'mismatch',
        { noun: 'worktrees', verb: 'mismatch', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ issues: unknown[] }>(stdout).data!;
    expect(Array.isArray(data.issues)).toBe(true);
  });
});
