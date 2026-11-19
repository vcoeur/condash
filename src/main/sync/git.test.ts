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
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../exec';
import {
  assertRecoveryAttributeProof,
  assertRecoveryFastForward,
  assertRecoveryGitState,
  behindUpstream,
  commitPaths,
  fetchUpstream,
  ffOnlyMerge,
  formatGitDiagnostic,
  proveInertRecoveryOutputs,
  readRecoveryBlob,
  readRecoveryChanges,
  readRecoveryDirectory,
  readRecoveryGitState,
  recoveryPathsOverlap,
  verifyRecoveryOutputObjects,
  verifyRecoveryCommitTree,
  type RecoveryCommitCheckpoints,
} from './git';

let savedGlobal: string | undefined;
let savedSystem: string | undefined;
let savedLocale: string | undefined;

describe('bounded pinned directory metadata for the shared prospective walker', () => {
  let root: string;
  let head: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'condash-pinned-directory-'));
    await git(root, 'init', '-q', '-b', 'main');
    await setIdentity(root);
    await fs.mkdir(join(root, 'knowledge'));
    await fs.writeFile(join(root, 'knowledge/index.md'), '# Human\n');
    await fs.writeFile(join(root, 'knowledge/binary.bin'), Buffer.alloc(64 * 1024, 0xff));
    await fs.symlink('missing-payload', join(root, 'knowledge/dependency-link'));
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'fixture directory metadata');
    head = (await git(root, 'rev-parse', 'HEAD')).trim();
  });

  it('reads bounded names/modes/OIDs only and leaves irrelevant blobs and symlinks unopened', async () => {
    const limits = { maxBytes: 1024, maxEntries: 10 };
    const entries = await readRecoveryDirectory(root, head, limits);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'knowledge', mode: '040000', kind: 'directory' });
    const children = await readRecoveryDirectory(root, entries[0].oid, limits);
    expect(children.map(({ name, mode, kind }) => ({ name, mode, kind }))).toEqual([
      { name: 'binary.bin', mode: '100644', kind: 'file' },
      { name: 'dependency-link', mode: '120000', kind: 'other' },
      { name: 'index.md', mode: '100644', kind: 'file' },
    ]);
    await expect(readRecoveryBlob(root, children[0].oid, limits)).rejects.toThrow('byte limit');
  });

  it('enforces directory entry/byte bounds without recursive whole-tree capture or diagnostic parsing', async () => {
    const entries = await readRecoveryDirectory(root, head, { maxBytes: 1024, maxEntries: 10 });
    await expect(
      readRecoveryDirectory(root, entries[0].oid, { maxBytes: 1024, maxEntries: 1 }),
    ).rejects.toThrow('entry limit');
    await expect(
      readRecoveryDirectory(root, entries[0].oid, { maxBytes: 1, maxEntries: 10 }),
    ).rejects.toThrow();
    await expect(
      readRecoveryDirectory(root, 'HEAD:knowledge', { maxBytes: 1024, maxEntries: 10 }),
    ).rejects.toThrow('pinned Git object');
  });
});

describe('bounded Git diagnostics', () => {
  it('uses the first nonempty source, retaining multiline paths', () => {
    expect(
      formatGitDiagnostic({
        stderr: ' \n',
        stdout: 'heading\n  path/index.md\n',
        message: 'fallback',
      }),
    ).toBe('heading\npath/index.md');
    expect(formatGitDiagnostic({ stderr: '', stdout: '', message: 'message' })).toBe('message');
    expect(formatGitDiagnostic({})).toBe('unknown error');
  });
  it('caps lines and UTF-8 bytes including the explicit truncation marker', () => {
    const lines = formatGitDiagnostic({
      stderr: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'),
    });
    expect(lines.split('\n')).toHaveLength(12);
    expect(lines).toContain('[diagnostic truncated]');
    const bytes = formatGitDiagnostic({ stderr: 'é'.repeat(5000) });
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(4096);
    expect(bytes).toContain('[diagnostic truncated]');
    expect(bytes).not.toContain('\ufffd');
  });
});

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

describe('recovery Git proofs (real Git)', () => {
  const limits = { maxBytes: 8 * 1024 * 1024, maxEntries: 100_000 };
  const output = 'knowledge/index.md';
  const protectedBytes = Buffer.from('# Index\n\nHuman <!-- retain -->\n');
  let base: string;
  let a: string;
  let b: string;
  let remote: string;
  let privateDirectory: string;
  let head: string;
  let environment: NodeJS.ProcessEnv;

  async function write(root: string, path: string, bytes: string | Buffer): Promise<void> {
    await fs.mkdir(dirname(join(root, path)), { recursive: true });
    await fs.writeFile(join(root, path), bytes);
  }

  async function incoming(): Promise<string> {
    await write(b, 'incoming.txt', 'incoming\n');
    await git(b, 'add', '-A');
    await git(b, 'commit', '-qm', 'advance fixture');
    await git(b, 'push', '-q');
    await fetchUpstream(a);
    return (await git(b, 'rev-parse', 'HEAD')).trim();
  }

  async function proof(paths = [output]) {
    const state = await readRecoveryGitState(a, limits);
    return proveInertRecoveryOutputs(
      a,
      state.head,
      state.upstreamOid,
      paths,
      privateDirectory,
      limits,
    );
  }

  async function snapshot() {
    const index = await fs.stat(join(a, '.git/index'), { bigint: true });
    return {
      head: await git(a, 'rev-parse', 'HEAD'),
      branch: await git(a, 'symbolic-ref', 'HEAD'),
      index: await fs.readFile(join(a, '.git/index')),
      indexIdentity: [index.ino, index.mtimeNs, index.ctimeNs].join(':'),
      output: await fs.readFile(join(a, output)),
      remote: await git(remote, 'rev-parse', 'refs/heads/main'),
    };
  }

  it('checks the actual whole commit tree, including an output outside the selected group', async () => {
    const state = await readRecoveryGitState(a, limits);
    await verifyRecoveryCommitTree(a, state.head, state.entries, limits);
    const altered = state.entries.map((entry) =>
      entry.path === output ? { ...entry, oid: '0'.repeat(40) } : entry,
    );
    await expect(verifyRecoveryCommitTree(a, state.head, altered, limits)).rejects.toThrow(
      'commit tree differs',
    );
    await expect(
      verifyRecoveryCommitTree(a, state.head, state.entries.slice(1), limits),
    ).rejects.toThrow('commit tree differs');
    await expect(
      verifyRecoveryCommitTree(a, state.head, state.entries, { ...limits, maxEntries: 1 }),
    ).rejects.toThrow('entry limit');
  });

  function checkpoints(
    overrides: Partial<RecoveryCommitCheckpoints> = {},
  ): RecoveryCommitCheckpoints {
    return {
      beforeAdd: async () => {},
      afterAdd: async () => {},
      beforeCommit: async () => {},
      afterCommit: async () => {},
      ...overrides,
    };
  }

  async function configureFilter(path: string, { smudge = false } = {}): Promise<string> {
    const marker = join(base, 'filter-invocations');
    const program = join(base, 'filter.cjs');
    await fs.writeFile(
      program,
      `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n'); const raw = fs.readFileSync(0, 'utf8'); process.stdout.write(raw.replace(/Human <!-- retain -->/g, 'Human').replace(/^TRANSFORM$/gm, '## Salientquartz'));`,
    );
    const command = `${process.execPath} '${program}'`;
    await git(a, 'config', 'filter.fixture.clean', command);
    if (smudge) await git(a, 'config', 'filter.fixture.smudge', command);
    await write(a, '.gitattributes', `${path} filter=fixture\n`);
    return marker;
  }

  beforeEach(async () => {
    environment = { ...process.env };
    base = await fs.mkdtemp(join(tmpdir(), 'condash-recovery-git-'));
    const home = join(base, 'home');
    await fs.mkdir(home);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    process.env.GIT_ATTR_SYSTEM = join(base, 'system-attributes');
    delete process.env.GIT_ATTR_NOSYSTEM;
    a = join(base, 'a');
    b = join(base, 'b');
    remote = join(base, 'remote.git');
    privateDirectory = join(base, 'private');
    await fs.mkdir(privateDirectory, { mode: 0o700 });
    await fs.mkdir(a);
    await git(a, 'init', '-qb', 'main');
    await setIdentity(a);
    await git(a, 'config', 'core.autocrlf', 'false');
    await write(a, output, protectedBytes);
    await write(a, 'knowledge/body.md', '# Body\n');
    await write(a, 'knowledge/2026-07-12-source/index.md', '# Source\n');
    await write(a, '.gitattributes', '*.md -text\n');
    await git(a, 'add', '.');
    await git(a, 'commit', '-qm', 'seed fixture');
    head = (await git(a, 'rev-parse', 'HEAD')).trim();
    await git(base, 'init', '--bare', '-qb', 'main', remote);
    await git(a, 'remote', 'add', 'origin', remote);
    await git(a, 'push', '-qu', 'origin', 'main');
    await git(base, 'clone', '-q', remote, b);
    await setIdentity(b);
    await git(b, 'config', 'core.autocrlf', 'false');
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await fs.rm(base, { recursive: true, force: true });
  });

  it('pins complete refs/destinations and exact stage-zero identities without changing live state', async () => {
    await incoming();
    const before = await snapshot();
    const state = await readRecoveryGitState(a, limits);
    expect(state).toMatchObject({
      head,
      branch: 'refs/heads/main',
      upstream: 'refs/remotes/origin/main',
      remote: 'origin',
      mergeRef: 'refs/heads/main',
      pushRemote: 'origin',
      pushMergeRef: 'refs/heads/main',
      staged: '',
    });
    expect(state.remoteUrls).toEqual([remote]);
    expect(state.entries.find((entry) => entry.path === output)).toMatchObject({
      mode: '100644',
      stage: 0,
      flag: 'H',
      flags: '0',
    });
    await assertRecoveryFastForward(a, state, limits);
    await assertRecoveryGitState(a, state, limits);
    await proof();
    expect(await snapshot()).toEqual(before);
  });

  it('returns NUL-delimited unusual paths, modes, OIDs and no rename guesses', async () => {
    const unusual = 'knowledge/a\tline\n" :[literal].md';
    await write(b, unusual, '# Weird\n');
    await fs.chmod(join(b, output), 0o755);
    await fs.rename(join(b, 'knowledge/body.md'), join(b, 'knowledge/renamed.md'));
    const incomingOid = await incoming();
    const delta = await readRecoveryChanges(a, head, incomingOid, limits);
    expect(delta.find((change) => change.path === unusual)).toMatchObject({
      status: 'A',
      oldMode: '000000',
      newMode: '100644',
    });
    expect(delta.find((change) => change.path === output)).toMatchObject({
      status: 'M',
      oldMode: '100644',
      newMode: '100755',
    });
    expect(delta.find((change) => change.path === 'knowledge/body.md')?.status).toBe('D');
    expect(delta.find((change) => change.path === 'knowledge/renamed.md')?.status).toBe('A');
    expect(recoveryPathsOverlap('knowledge/index.md', 'knowledge/index.md/child')).toBe(true);
    expect(recoveryPathsOverlap('knowledge/index.md', 'knowledge/index.md-other')).toBe(false);
  });

  it.each(['assume', 'skip', 'intent', 'staged', 'sparse', 'sparse-index', 'unmerged'])(
    'refuses %s stage state without repairing or restoring it',
    async (kind) => {
      if (kind === 'assume') await git(a, 'update-index', '--assume-unchanged', output);
      if (kind === 'skip') await git(a, 'update-index', '--skip-worktree', output);
      if (kind === 'intent') {
        await write(a, 'intent.md', 'new\n');
        await git(a, 'add', '--intent-to-add', 'intent.md');
      }
      if (kind === 'staged') {
        await write(a, output, 'staged human\n');
        await git(a, 'add', output);
      }
      if (kind === 'sparse') await git(a, 'config', 'core.sparseCheckout', 'true');
      if (kind === 'sparse-index') await git(a, 'config', 'index.sparse', 'true');
      if (kind === 'unmerged') {
        const oid = (await git(a, 'rev-parse', `HEAD:${output}`)).trim();
        execFileSync('git', ['update-index', '--index-info'], {
          cwd: a,
          env: process.env,
          input: `0 ${'0'.repeat(40)}\t${output}\n100644 ${oid} 1\t${output}\n100644 ${oid} 2\t${output}\n`,
        });
      }
      const before = await snapshot();
      await expect(readRecoveryGitState(a, limits)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    'GIT_INDEX_FILE',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_GLOBAL',
    'GIT_SHALLOW_FILE',
    'GIT_REPLACE_REF_BASE',
  ])('refuses %s environment redirection rather than silently discarding it', async (key) => {
    process.env[key] = key === 'GIT_CONFIG_COUNT' ? '0' : join(base, 'redirect');
    await expect(readRecoveryGitState(a, limits)).rejects.toThrow(/redirection/);
  });

  it('detects a same-OID attached-branch switch and upstream destination/config changes', async () => {
    const state = await readRecoveryGitState(a, limits);
    await git(a, 'branch', 'twin');
    await git(a, 'config', 'branch.twin.remote', 'origin');
    await git(a, 'config', 'branch.twin.merge', 'refs/heads/main');
    await git(a, 'symbolic-ref', 'HEAD', 'refs/heads/twin');
    expect((await git(a, 'rev-parse', 'HEAD')).trim()).toBe(state.head);
    await expect(assertRecoveryGitState(a, state, limits)).rejects.toThrow(
      'identity or index drift',
    );
  });

  it('keeps the full branch identity when a tag shares its short name and detects upstream drift', async () => {
    await git(a, 'tag', 'main');
    const state = await readRecoveryGitState(a, limits);
    expect(state.branch).toBe('refs/heads/main');
    await git(a, 'config', 'branch.main.merge', 'refs/heads/other');
    await expect(assertRecoveryGitState(a, state, limits)).rejects.toThrow();
  });

  it('bounds raw blobs before loading them and returns binary bytes without decoding', async () => {
    const bytes = Buffer.from([0, 255, 128, 4]);
    await write(a, 'binary', bytes);
    const oid = (await git(a, 'hash-object', '-w', 'binary')).trim();
    expect(await readRecoveryBlob(a, oid, limits)).toEqual(bytes);
    await expect(readRecoveryBlob(a, oid, { ...limits, maxBytes: 2 })).rejects.toThrow(
      'byte limit',
    );
    await expect(readRecoveryBlob(a, head, limits)).rejects.toThrow('not a blob');
    await expect(readRecoveryChanges(a, '--bad-option', head, limits)).rejects.toThrow('object ID');
    await expect(readRecoveryGitState(a, { ...limits, maxEntries: 1 })).rejects.toThrow(
      'entry limit',
    );
  });

  it('uses private pinned indexes for nested H/M attributes and accepts explicit -text', async () => {
    await write(b, 'knowledge/.gitattributes', 'index.md -text\n');
    const incomingOid = await incoming();
    const result = await proveInertRecoveryOutputs(
      a,
      head,
      incomingOid,
      [output],
      privateDirectory,
      limits,
    );
    expect(result.privateIndexes).toHaveLength(2);
    expect(
      result.attributes.filter((entry) => entry.attribute === 'text').map((entry) => entry.value),
    ).toEqual(['unset', 'unset', 'unset']);
    for (const index of result.privateIndexes)
      expect((await fs.stat(index)).mode & 0o777).toBe(0o600);
    await assertRecoveryAttributeProof(a, result, limits);
  });

  it.each(['head', 'incoming'])(
    'refuses non-inert %s attributes even when current worktree attributes are inert',
    async (epoch) => {
      const root = epoch === 'head' ? a : b;
      await write(root, '.gitattributes', `${output} ident\n`);
      await git(root, 'add', '.gitattributes');
      await git(root, 'commit', '-qm', 'non-inert pinned attributes');
      const pinned = (await git(root, 'rev-parse', 'HEAD')).trim();
      if (epoch === 'incoming') {
        await git(b, 'push', '-q');
        await fetchUpstream(a);
      }
      await write(a, '.gitattributes', '*.md -text\n');
      const before = await snapshot();
      await expect(
        proveInertRecoveryOutputs(
          a,
          epoch === 'head' ? pinned : head,
          epoch === 'incoming' ? pinned : head,
          [output],
          privateDirectory,
          limits,
        ),
      ).rejects.toThrow('ident=set');
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([Buffer.from([0xff, 0x0a]), Buffer.from('*.md -text\0ignored')])(
    'refuses non-text attribute dependencies without invoking a conversion',
    async (bytes) => {
      await write(a, '.gitattributes', bytes);
      const before = await snapshot();
      await expect(proof()).rejects.toThrow(/UTF-8|NUL/);
      expect(await snapshot()).toEqual(before);
    },
  );

  it('bounds and validates a missing worktree attribute file through the actual live-index fallback', async () => {
    await write(a, '.gitattributes', '*.md -text\0invalid');
    await git(a, 'add', '.gitattributes');
    await fs.unlink(join(a, '.gitattributes'));
    await expect(
      proveInertRecoveryOutputs(a, head, head, [output], privateDirectory, limits),
    ).rejects.toThrow('NUL in committed attribute file');
  });

  it.each([
    'text',
    'text=auto',
    'eol=crlf',
    'filter=fixture',
    'ident',
    'working-tree-encoding=UTF-16',
    'crlf',
  ])('refuses non-inert current %s without invoking conversion', async (attribute) => {
    await write(a, '.gitattributes', `${output} ${attribute}\n`);
    const before = await snapshot();
    await expect(proof()).rejects.toThrow('Non-inert output attribute');
    expect(await snapshot()).toEqual(before);
  });

  it('rejects an incoming noncandidate clean-only filter before any local candidate write or filter execution', async () => {
    const marker = await configureFilter('assets/*.dat');
    await write(a, '.gitattributes', '*.md -text\n');
    await write(b, '.gitattributes', '*.md -text\nknowledge/body.md filter=fixture\n');
    const incomingOid = await incoming();
    const before = await snapshot();
    await expect(
      proveInertRecoveryOutputs(
        a,
        head,
        incomingOid,
        [output, 'knowledge/body.md'],
        privateDirectory,
        limits,
      ),
    ).rejects.toThrow('filter=fixture');
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshot()).toEqual(before);
  });

  it.each(['macro', 'info', 'global'])(
    'resolves %s attributes through Git and refuses their non-inert effect',
    async (source) => {
      if (source === 'macro')
        await write(a, '.gitattributes', `[attr]generated filter=fixture\n${output} generated\n`);
      if (source === 'info') await write(a, '.git/info/attributes', `${output} filter=fixture\n`);
      if (source === 'global') {
        const path = join(base, 'global-attributes');
        await fs.writeFile(path, `${output} filter=fixture\n`);
        await git(a, 'config', 'core.attributesFile', path);
      }
      await expect(proof()).rejects.toThrow('filter=fixture');
    },
  );

  it('records the actual system attribute dependency resolved by Git, not an invented environment override', async () => {
    // Git exposes this path through `var`; GIT_ATTR_SYSTEM is not an override.
    const path = (await git(a, 'var', 'GIT_ATTR_SYSTEM')).trim();
    const result = await proof();
    const dependency = result.dependencies.find((entry) => entry.path === path);
    expect(dependency).toBeDefined();
    expect(path).not.toBe(process.env.GIT_ATTR_SYSTEM);
    const stat = await fs.lstat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    expect(dependency!.identity === null).toBe(stat === null);
    process.env.GIT_ATTR_NOSYSTEM = '1';
    await expect(assertRecoveryAttributeProof(a, result, limits)).rejects.toThrow(
      'configuration drift',
    );
  });

  it('records global config and resolved include dependencies and detects same-content stat drift', async () => {
    delete process.env.GIT_CONFIG_GLOBAL;
    const included = join(process.env.HOME!, 'included');
    await fs.writeFile(included, '[core]\n autocrlf = false\n');
    await fs.writeFile(join(process.env.HOME!, '.gitconfig'), '[include]\n path = included\n');
    const result = await proof();
    expect(result.dependencies.map((entry) => entry.path)).toContain(included);
    await fs.utimes(included, new Date(0), new Date(0));
    await expect(assertRecoveryAttributeProof(a, result, limits)).rejects.toThrow(
      'dependency drift',
    );
  });

  it('records explicitly disabled system resolution without treating its absent git-var value as an error', async () => {
    process.env.GIT_ATTR_NOSYSTEM = '1';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const result = await proof();
    expect(result.environment.GIT_ATTR_NOSYSTEM).toBe('1');
    expect(result.dependencies.map((entry) => entry.path)).not.toContain('/etc/gitattributes');
    await assertRecoveryAttributeProof(a, result, limits);
  });

  it.each(['config', 'attribute', 'missing-include', 'unknown-type', 'autocrlf'])(
    'fails closed on %s uncertainty or drift',
    async (change) => {
      const result = await proof();
      if (change === 'config') await git(a, 'config', 'core.eol', 'crlf');
      if (change === 'attribute')
        await fs.appendFile(join(a, '.gitattributes'), `${output} ident\n`);
      if (change === 'missing-include') {
        await git(a, 'config', 'include.path', join(base, 'new-config'));
        await fs.writeFile(join(base, 'new-config'), '[core]\n autocrlf = true\n');
      }
      if (change === 'unknown-type') {
        await fs.unlink(join(a, '.gitattributes'));
        await fs.symlink('knowledge/index.md', join(a, '.gitattributes'));
      }
      if (change === 'autocrlf') await git(a, 'config', 'core.autocrlf', 'input');
      await expect(assertRecoveryAttributeProof(a, result, limits)).rejects.toThrow();
    },
  );

  it('allows source-only checkout conversion and irrelevant symlinks/LFS-style drivers', async () => {
    const source = 'knowledge/2026-07-12-source/index.md';
    await configureFilter(source, { smudge: true });
    await git(a, 'add', '.gitattributes');
    await git(a, 'commit', '-qm', 'seed source-only filter rule');
    await git(a, 'push', '-q');
    await git(b, 'fetch', '-q');
    await git(b, 'merge', '--ff-only', '-q');
    head = (await git(a, 'rev-parse', 'HEAD')).trim();
    await git(a, 'config', 'filter.lfs.process', 'unavailable-fixture-lfs');
    await fs.symlink('/nonexistent-fixture-dependency', join(a, 'dependency'));
    // The source rule exists in both pinned trees before recovery is considered.
    await write(b, source, 'TRANSFORM\n');
    const incomingOid = await incoming();
    const state = await readRecoveryGitState(a, limits);
    await assertRecoveryFastForward(a, state, limits);
    await proveInertRecoveryOutputs(a, head, incomingOid, [output], privateDirectory, limits);
    expect(await ffOnlyMerge(a, incomingOid)).toEqual({ ok: true });
    expect(await fs.readFile(join(a, source), 'utf8')).toBe('## Salientquartz\n');
    expect(await git(a, 'show', `${incomingOid}:${source}`)).toBe('TRANSFORM\n');
  });

  it('uses the pinned guarded FF without overwriting an ignored obstruction or running an extra merge', async () => {
    await write(a, '.git/info/exclude', 'collision.dat\n');
    await write(a, 'collision.dat', 'private ignored bytes\n');
    await write(b, 'collision.dat', 'incoming bytes\n');
    const incomingOid = await incoming();
    const before = await snapshot();
    const merged = await ffOnlyMerge(a, incomingOid);
    expect(merged.ok).toBe(false);
    expect(await fs.readFile(join(a, 'collision.dat'), 'utf8')).toBe('private ignored bytes\n');
    expect(await snapshot()).toEqual(before);
  });

  it('keeps real post-merge hooks enabled for the optional pinned FF', async () => {
    const marker = join(base, 'post-merge-ran');
    await write(a, '.git/hooks/post-merge', `#!/bin/sh\nprintf ran >> '${marker}'\n`);
    await fs.chmod(join(a, '.git/hooks/post-merge'), 0o755);
    const incomingOid = await incoming();
    expect(await ffOnlyMerge(a, incomingOid)).toEqual({ ok: true });
    expect(await fs.readFile(marker, 'utf8')).toBe('ran');
  });

  it('brackets actual add/commit-only objects and verifies committed bytes with hooks enabled', async () => {
    const events: string[] = [];
    const marker = join(base, 'pre-commit-ran');
    await write(a, '.git/hooks/pre-commit', `#!/bin/sh\nprintf ran >> '${marker}'\n`);
    await fs.chmod(join(a, '.git/hooks/pre-commit'), 0o755);
    const result = await proof();
    const proposed = Buffer.from('new generated text\nHuman <!-- retain -->\n');
    await write(a, output, proposed);
    const sha = await commitPaths(
      a,
      [output],
      'fixture output',
      checkpoints({
        beforeAdd: async () => {
          events.push('before-add');
          await assertRecoveryAttributeProof(a, result, limits);
        },
        afterAdd: async () => {
          events.push('after-add');
          const state = await readRecoveryGitState(a, limits, { allowStaged: true });
          await verifyRecoveryOutputObjects(
            a,
            { stage: state.entries },
            [{ path: output, bytes: proposed }],
            limits,
          );
        },
        beforeCommit: async () => {
          events.push('before-commit');
          await assertRecoveryAttributeProof(a, result, limits);
        },
        afterCommit: async (_paths, oid) => {
          events.push('after-commit');
          await verifyRecoveryOutputObjects(
            a,
            { commit: oid! },
            [{ path: output, bytes: proposed }],
            limits,
          );
        },
      }),
    );
    expect(sha).not.toBe(head);
    expect(events).toEqual(['before-add', 'after-add', 'before-commit', 'after-commit']);
    expect(await fs.readFile(marker, 'utf8')).toBe('ran');
  });

  it('detects clean-only staged loss and leaves the actual staged effect rather than claiming no effect', async () => {
    await configureFilter(output);
    const proposed = Buffer.from('new\nHuman <!-- retain -->\n');
    await write(a, output, proposed);
    await expect(
      commitPaths(
        a,
        [output],
        'must not commit',
        checkpoints({
          afterAdd: async () => {
            const state = await readRecoveryGitState(a, limits, { allowStaged: true });
            await verifyRecoveryOutputObjects(
              a,
              { stage: state.entries },
              [{ path: output, bytes: proposed }],
              limits,
            );
          },
        }),
      ),
    ).rejects.toThrow('object mismatch');
    expect((await git(a, 'rev-parse', 'HEAD')).trim()).toBe(head);
    expect(await git(a, 'show', `:${output}`)).toBe('new\nHuman\n');
    expect(await fs.readFile(join(a, output))).toEqual(proposed);
  });

  it('rechecks attrs before commit-only and stops after staging if they drift', async () => {
    const result = await proof();
    await write(a, output, 'new\nHuman <!-- retain -->\n');
    await expect(
      commitPaths(
        a,
        [output],
        'must not commit',
        checkpoints({
          afterAdd: async () => {
            await configureFilter(output);
          },
          beforeCommit: async () => {
            await assertRecoveryAttributeProof(a, result, limits);
          },
        }),
      ),
    ).rejects.toThrow('configuration drift');
    expect((await git(a, 'rev-parse', 'HEAD')).trim()).toBe(head);
    expect(await git(a, 'show', `:${output}`)).toContain('<!-- retain -->');
  });

  it('detects real commit-only recleaned object loss after the actual local commit, without undoing it', async () => {
    const proposed = Buffer.from('new\nHuman <!-- retain -->\n');
    await write(a, output, proposed);
    await expect(
      commitPaths(
        a,
        [output],
        'fixture actual partial commit',
        checkpoints({
          beforeCommit: async () => {
            await configureFilter(output);
          },
          afterCommit: async (_paths, sha) => {
            await verifyRecoveryOutputObjects(
              a,
              { commit: sha! },
              [{ path: output, bytes: proposed }],
              limits,
            );
          },
        }),
      ),
    ).rejects.toThrow('object mismatch');
    expect((await git(a, 'rev-parse', 'HEAD')).trim()).not.toBe(head);
    expect(await git(a, 'show', `HEAD:${output}`)).toBe('new\nHuman\n');
    expect((await git(remote, 'rev-parse', 'main')).trim()).toBe(head);
  });

  it('propagates a recovery commit failure even when a real hook prints no-op diagnostic text', async () => {
    await write(a, output, 'new bytes\n');
    await write(
      a,
      '.git/hooks/pre-commit',
      '#!/bin/sh\nprintf "nothing to commit\\n" >&2\nexit 1\n',
    );
    await fs.chmod(join(a, '.git/hooks/pre-commit'), 0o755);
    let completed = false;
    await expect(
      commitPaths(
        a,
        [output],
        'must not authorize by stderr',
        checkpoints({
          afterCommit: async () => {
            completed = true;
          },
        }),
      ),
    ).rejects.toThrow();
    expect(completed).toBe(false);
    expect((await git(a, 'rev-parse', 'HEAD')).trim()).toBe(head);
    expect(await git(a, 'show', `:${output}`)).toBe('new bytes\n');
  });

  it('awaits a fresh checkpoint around every actual add chunk', async () => {
    const paths = Array.from({ length: 101 }, (_, index) => `knowledge/generated-${index}.md`);
    for (const path of paths) await write(a, path, '# Generated\n');
    const events: string[] = [];
    await commitPaths(
      a,
      paths,
      'fixture chunk boundaries',
      checkpoints({
        beforeAdd: async (chunk) => {
          events.push(`before:${chunk.length}`);
        },
        afterAdd: async (chunk) => {
          events.push(`after:${chunk.length}`);
          for (const path of chunk) expect(await git(a, 'show', `:${path}`)).toBe('# Generated\n');
        },
        beforeCommit: async () => {
          events.push('commit');
        },
        afterCommit: async () => {
          events.push('completed');
        },
      }),
    );
    expect(events).toEqual([
      'before:100',
      'after:100',
      'before:1',
      'after:1',
      'commit',
      'completed',
    ]);
  });

  it('checks attached identity after a real post-commit hook switches branch at the committed OID', async () => {
    await write(
      a,
      '.git/hooks/post-commit',
      '#!/bin/sh\ngit update-ref refs/heads/twin HEAD\ngit config branch.twin.remote origin\ngit config branch.twin.merge refs/heads/main\ngit symbolic-ref HEAD refs/heads/twin\n',
    );
    await fs.chmod(join(a, '.git/hooks/post-commit'), 0o755);
    await write(a, output, 'new bytes\n');
    await expect(
      commitPaths(
        a,
        [output],
        'fixture hook branch switch',
        checkpoints({
          afterCommit: async () => {
            const current = await readRecoveryGitState(a, limits);
            expect(current.branch).toBe('refs/heads/twin');
            await assertRecoveryGitState(a, { ...current, branch: 'refs/heads/main' }, limits);
          },
        }),
      ),
    ).rejects.toThrow('identity or index drift');
  });
});
