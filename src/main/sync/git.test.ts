/**
 * Integration tests for the fetch-first git helpers against real repos:
 * `fetchUpstream`, `behindUpstream`, `ffOnlyMerge`.
 *
 * A shared bare remote with two clones reproduces the sweeper's world: the
 * working clone is behind the remote until it fetches. Global git config is
 * pinned off (and locale pinned to C, since two assertions match git's own
 * error text), the same way run.test.ts does.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../exec';
import { behindUpstream, fetchUpstream, ffOnlyMerge } from './git';

let savedGlobal: string | undefined;
let savedSystem: string | undefined;
let savedLocale: string | undefined;

beforeAll(() => {
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  savedSystem = process.env.GIT_CONFIG_SYSTEM;
  savedLocale = process.env.LC_ALL;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.LC_ALL = 'C';
});

afterAll(() => {
  restore('GIT_CONFIG_GLOBAL', savedGlobal);
  restore('GIT_CONFIG_SYSTEM', savedSystem);
  restore('LC_ALL', savedLocale);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

/** Local identity for a fresh or cloned repo. */
async function setIdentity(repo: string): Promise<void> {
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
}

/** Write `content` to `name` in `repo`, stage it, and commit. */
async function commitFile(
  repo: string,
  name: string,
  content: string,
  subject: string,
): Promise<void> {
  await fs.writeFile(join(repo, name), content, 'utf8');
  await git(repo, 'add', name);
  await git(repo, 'commit', '-q', '-m', subject);
}

describe('fetch-first git helpers (real git)', () => {
  let base: string;
  let remote: string;
  let a: string;
  let b: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(join(tmpdir(), 'condash-git-test-'));
    remote = join(base, 'remote.git');
    a = join(base, 'a');
    b = join(base, 'b');

    // `cwd` must exist before `exec` spawns git, so init from `base` and pass
    // the bare-repo path as an argument.
    await git(base, 'init', '--bare', '-q', '-b', 'main', remote);
    await git(base, 'clone', '-q', remote, 'a');
    await setIdentity(a);
    await commitFile(a, 'same.txt', 'alpha\n', 'a commit');
    await git(a, 'push', '-u', '-q', 'origin', 'main');

    // Clone B advances the shared remote; clone A stays stale until a fetch.
    await git(base, 'clone', '-q', remote, 'b');
    await setIdentity(b);
    await commitFile(b, 'same.txt', 'beta\n', 'b commit');
    await git(b, 'push', '-q', 'origin', 'main');
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('behindUpstream returns null when the branch has no upstream', async () => {
    const solo = join(base, 'solo');
    await fs.mkdir(solo);
    await git(solo, 'init', '-q', '-b', 'main');
    await setIdentity(solo);
    await commitFile(solo, 'f.txt', 'one\n', 'first');

    expect(await behindUpstream(solo)).toBeNull();
  });

  it('behindUpstream counts commits the remote has that HEAD does not', async () => {
    await fetchUpstream(a);
    expect(await behindUpstream(a)).toBe(1);
  });

  it('fetchUpstream updates the tracking ref so behindUpstream sees the push', async () => {
    expect(await behindUpstream(a)).toBe(0);
    await fetchUpstream(a);
    expect(await behindUpstream(a)).toBe(1);
  });

  it('ffOnlyMerge fast-forwards when only the remote has advanced', async () => {
    await fetchUpstream(a);

    const result = await ffOnlyMerge(a);
    expect(result).toEqual({ ok: true });

    // HEAD now sits on the remote commit B pushed.
    expect(await git(a, 'rev-parse', 'HEAD')).toBe(await git(b, 'rev-parse', 'HEAD'));
    expect(await git(a, 'rev-parse', 'HEAD')).toBe(await git(a, 'rev-parse', '@{upstream}'));
  });

  it('ffOnlyMerge refuses when the branches have diverged', async () => {
    await commitFile(a, 'a2.txt', 'local\n', 'local-only commit');
    await fetchUpstream(a);

    const result = await ffOnlyMerge(a);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error).toMatch(/fast-forward/i);
  });

  it('ffOnlyMerge refuses when a remote update would clobber a local edit', async () => {
    await fetchUpstream(a);
    await fs.writeFile(join(a, 'same.txt'), 'gamma\n', 'utf8');

    const result = await ffOnlyMerge(a);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/merge|overwrit/i);
  });
});
