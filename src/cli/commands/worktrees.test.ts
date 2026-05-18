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
