/**
 * Tests for `condash repos list`. Drives `runRepos` directly against a
 * tmp conception with a seeded `condash.json:repos` block.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRepos } from './repos';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
} from './test-helpers';
import { CliError } from '../output';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
});

afterEach(async () => {
  await rmConception(conceptionPath);
});

async function seedRepos(repos: Array<{ name: string; path: string }>): Promise<void> {
  await fs.writeFile(
    join(conceptionPath, 'condash.json'),
    JSON.stringify({ repositories: repos }),
    'utf8',
  );
}

describe('runRepos list', () => {
  it('returns the repos block from condash.json', async () => {
    await seedRepos([
      { name: 'alpha', path: '/no/such/alpha' },
      { name: 'beta', path: '/no/such/beta' },
    ]);
    const { stdout, threw } = await captureStdout(() =>
      runRepos(
        'list',
        { noun: 'repos', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const repos = parseJsonEnvelope<Array<{ name: string; missing?: boolean }>>(stdout).data!;
    const names = repos.map((r) => r.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
    // Missing repos should be flagged.
    for (const r of repos) expect(r.missing).toBe(true);
  });

  it('strips the worktrees field from the default response', async () => {
    await seedRepos([{ name: 'alpha', path: '/no/such/alpha' }]);
    const { stdout: stdoutA } = await captureStdout(() =>
      runRepos(
        'list',
        { noun: 'repos', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const reposA = parseJsonEnvelope<Array<Record<string, unknown>>>(stdoutA).data!;
    expect(reposA[0]).not.toHaveProperty('worktrees');
  });

  it('accepts --include-worktrees without error', async () => {
    await seedRepos([{ name: 'alpha', path: '/no/such/alpha' }]);
    const { threw } = await captureStdout(() =>
      runRepos(
        'list',
        {
          noun: 'repos',
          verb: 'list',
          positional: [],
          flags: { 'include-worktrees': true },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
  });

  it('returns an empty list when no repos are configured', async () => {
    // Default makeTmpConception leaves `condash.json` as `{}`.
    const { stdout } = await captureStdout(() =>
      runRepos(
        'list',
        { noun: 'repos', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    const repos = parseJsonEnvelope<unknown[]>(stdout).data!;
    expect(repos).toEqual([]);
  });

  it('rejects an unknown verb with USAGE', async () => {
    const { threw } = await captureStdout(() =>
      runRepos(
        'banana',
        { noun: 'repos', verb: 'banana', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });

  it('--help prints help text', async () => {
    const { stdout, threw } = await captureStdout(() =>
      runRepos(
        'list',
        { noun: 'repos', verb: 'list', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
        true,
      ),
    );
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash repos list/);
  });
});
