/**
 * Integration tests for the sweeper against a real git repo.
 *
 * `syncRun` shells out through `exec`, which inherits `process.env`, so the
 * developer's global git config (hooks path, gpgsign, aliases) is pinned off
 * for the whole file rather than per-invocation.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProjectReadme } from '../../cli/commands/test-helpers';
import { exec } from '../exec';
import { syncCommit, syncRun, SyncRefusedError } from './run';
import { regenerateIndex } from '../index-tree';
import { projectsStrategy } from '../index-projects';
import { knowledgeStrategy } from '../index-knowledge';
import * as gitApi from './git';
import * as lockApi from './lock';
import { RecoveryJournal, readRecoveryManifest } from './index-recovery';
import { closeRecoveryFixtureParent, openRecoveryFixtureParent } from './recovery-test-env';

// The guarded-orchestration describe below activates real recovery journals,
// whose ancestor gate refuses CI's world-writable /tmp chain, so every
// mkdtemp fixture in this file roots under the private parent described in
// recovery-test-env.ts.
let fixtureParent: string;

beforeAll(async () => {
  fixtureParent = await openRecoveryFixtureParent('run');
});
afterAll(async () => {
  await closeRecoveryFixtureParent('run');
});

describe('actual guarded generated-index sync orchestration', () => {
  let root: string;
  let remote: string;
  let clone: string;
  let initial: string;
  let incoming: string;
  let local: string;
  const output = 'knowledge/index.md';
  const source = 'knowledge/2026-07-10-skipped/index.md';
  beforeEach(async () => {
    root = await makeGitConception();
    remote = join(root, '.git/fixture-remote.git');
    clone = join(root, '.git/fixture-incoming');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  async function scenario(kind = 'ordinary') {
    await git(root, 'config', 'core.autocrlf', 'false');
    await fs.writeFile(join(root, '.gitattributes'), '*.md -text\n');
    await fs.writeFile(join(root, 'knowledge/body.md'), '# Body\n\nFirst source content.\n');
    let index = '# Human\n\n- [`body.md`](body.md) — *First source content.* <!-- draft -->\n';
    if (kind === 'annotated-transform' || kind === 'safe-transform') {
      await fs.mkdir(join(root, 'knowledge/2026-07-10-skipped'));
      await fs.writeFile(join(root, source), '## Before\n');
      index += `- [\`2026-07-10-skipped/\`](2026-07-10-skipped/index.md) — *Before.*${kind === 'annotated-transform' ? ' <!-- human annotation -->' : ''} <!-- draft -->\n`;
      await fs.appendFile(join(root, '.gitattributes'), `${source} filter=heading\n`);
      const filter = join(root, '.git/source-filter.cjs');
      await fs.writeFile(
        filter,
        `const fs=require('node:fs');const text=fs.readFileSync(0,'utf8');process.stdout.write(process.argv[2]==='smudge'?text.replace(/^TRANSFORM$/gm,'## Salientquartz'):text.replace(/^## Salientquartz$/gm,'TRANSFORM'));`,
      );
      await git(root, 'config', 'filter.heading.clean', `${process.execPath} '${filter}' clean`);
      await git(root, 'config', 'filter.heading.smudge', `${process.execPath} '${filter}' smudge`);
    }
    await fs.writeFile(join(root, output), index);
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'guarded baseline');
    initial = (await git(root, 'rev-parse', 'HEAD')).trim();
    await git(root, 'init', '--bare', '-q', '-b', 'main', remote);
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-qu', 'origin', 'main');
    await git(root, 'clone', '-q', remote, clone);
    await git(clone, 'config', 'user.name', 'Fixture');
    await git(clone, 'config', 'user.email', 'fixture@example.invalid');
    await fs.writeFile(
      join(clone, output),
      index + '- [`remote.md`](remote.md) — *Remote source.* <!-- draft -->\n',
    );
    await fs.writeFile(join(clone, 'knowledge/remote.md'), '# Remote\n\nRemote source.\n');
    if (kind.includes('transform')) await fs.writeFile(join(clone, source), 'TRANSFORM\n');
    if (kind === 'noncandidate-filter')
      await fs.appendFile(join(clone, '.gitattributes'), 'projects/index.md filter=strip\n');
    if (kind === 'candidate-filter')
      await fs.appendFile(join(clone, '.gitattributes'), `${output} filter=strip\n`);
    await git(clone, 'add', '.');
    await git(clone, 'commit', '-qm', 'guarded incoming');
    await git(clone, 'push', '-q');
    incoming = (await git(clone, 'rev-parse', 'HEAD')).trim();
    local = index.replace('First source content.*', 'Stale second-source row.*');
    await fs.writeFile(join(root, output), local);
    await fs.writeFile(
      join(root, 'knowledge/body.md'),
      '# Body\n\nSecond source edit with moonstone details.\n',
    );
    await settle(join(root, output), join(root, 'knowledge/body.md'));
  }
  const options = { ...RUN_DEFAULTS, push: true, quietPeriodSeconds: 0 };
  it('normalizes exact H, uses actual guarded generation and verifies real local/remote output objects', async () => {
    await scenario();
    const report = await syncRun(root, options);
    expect(report.integrateError).toBeNull();
    expect(report.pushed).toBe(true);
    expect(report.commits.length).toBeGreaterThan(0);
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
    expect(await git(remote, 'show', 'main:knowledge/index.md')).toBe(
      await fs.readFile(join(root, output), 'utf8'),
    );
    expect(await git(remote, 'show', 'main:knowledge/body.md')).toContain('Second source edit');
    expect(await fs.readFile(join(root, output), 'utf8')).toContain('moonstone');
    expect(await lockApi.inspectRecoveryEvidence(join(root, '.git'))).toEqual([]);
  }, 90_000);
  it('warms an opaque hook, defers unrelated commits too and resumes a fresh cutoff without another fetch/FF/hook', async () => {
    await scenario();
    const hookLog = join(root, '.git/once.log');
    await fs.writeFile(
      join(root, '.git/hooks/post-merge'),
      `#!/bin/sh\nprintf 'ran\\n' >> '${hookLog}'\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(join(root, 'meta.txt'), 'unrelated settled\n');
    await settle(join(root, 'meta.txt'));
    const first = await syncRun(root, { ...options, quietPeriodSeconds: 90 });
    expect(first.integrateError).toBeNull();
    expect(first.indexesDeferred).toBe(true);
    expect(first.commits).toEqual([]);
    expect(first.pushed).toBe(false);
    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(incoming);
    const fetch = await fs.readFile(join(root, '.git/FETCH_HEAD'));
    await expect(syncRun(root, { ...options, push: false })).rejects.toBeInstanceOf(
      SyncRefusedError,
    );
    await expect(
      syncCommit(root, 'projects/2026-07/2026-07-10-alpha', 'blocked', options),
    ).rejects.toBeInstanceOf(SyncRefusedError);
    await fs.appendFile(join(root, output), '\nLater retained prose\n');
    const second = await syncRun(root, options);
    expect(second.integrateError).toBeNull();
    expect(second.commits).toEqual([]);
    expect(second.indexesDeferred).toBe(true);
    const third = await syncRun(root, options);
    expect(third.integrateError).toBeNull();
    expect(third.pushed).toBe(true);
    expect(third.indexesDeferred).toBe(false);
    expect(await git(remote, 'show', 'main:meta.txt')).toBe('unrelated settled\n');
    expect(await git(remote, 'show', 'main:knowledge/index.md')).toContain('Later retained prose');
    expect(await fs.readFile(hookLog, 'utf8')).toBe('ran\n');
    expect(await fs.readFile(join(root, '.git/FETCH_HEAD'))).toEqual(fetch);
  }, 90_000);
  it.each(['noncandidate-filter', 'candidate-filter'])(
    'refuses incoming %s before any candidate replacement',
    async (kind) => {
      await scenario(kind);
      const before = await fs.stat(join(root, output), { bigint: true });
      const report = await syncRun(root, options);
      expect(report.integrateError).not.toBeNull();
      expect(report.commits).toEqual([]);
      expect(report.pushed).toBe(false);
      expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(initial);
      expect(await fs.readFile(join(root, output), 'utf8')).toBe(local);
      const after = await fs.stat(join(root, output), { bigint: true });
      expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
        before.ino,
        before.mtimeNs,
        before.ctimeNs,
      ]);
    },
    30_000,
  );
  it.each(['annotated-transform', 'safe-transform'])(
    'consumes actual converted A for %s rather than raw M, preserving requirements or stopping the parent write',
    async (kind) => {
      await scenario(kind);
      const draft = knowledgeStrategy.draftSubdirEntry;
      const observations: { name: string; keywords: string[]; bytes: string }[] = [];
      vi.spyOn(knowledgeStrategy, 'draftSubdirEntry').mockImplementation(async (...args) => {
        const result = await draft(...args);
        if (args[1].name === '2026-07-10-skipped')
          observations.push({
            name: args[1].name,
            keywords: result.keywords,
            bytes: await fs.readFile(join(args[1].absPath, 'index.md'), 'utf8'),
          });
        return result;
      });
      const report = await syncRun(root, options);
      expect(observations.some((observation) => observation.bytes === '## Salientquartz\n')).toBe(
        true,
      );
      expect(
        observations.some((observation) =>
          observation.keywords.some((keyword) => /Salientquartz/i.test(keyword)),
        ),
      ).toBe(true);
      expect(await fs.readFile(join(root, source), 'utf8')).toBe('## Salientquartz\n');
      expect(await git(clone, 'show', `${incoming}:${source}`)).toBe('TRANSFORM\n');
      if (kind === 'annotated-transform') {
        expect(report.integrateError).toContain('Protected recovery sequence lost');
        expect(report.commits).toEqual([]);
        expect(report.pushed).toBe(false);
        expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(incoming);
        expect(await fs.readFile(join(root, output), 'utf8')).toBe(
          await git(clone, 'show', `${incoming}:${output}`),
        );
        expect(await fs.readFile(join(root, output), 'utf8')).toContain('human annotation');
      } else {
        expect(report.integrateError).toBeNull();
        expect(report.pushed).toBe(true);
        expect(await git(remote, 'show', `main:${output}`)).toBe(
          await fs.readFile(join(root, output), 'utf8'),
        );
        expect(await git(remote, 'show', `main:${source}`)).toBe('TRANSFORM\n');
      }
    },
    30_000,
  );
  it('records an actual hook-caused incompatible local commit and stops every later group/push', async () => {
    await scenario();
    const hook = join(root, '.git/hooks/pre-commit');
    await fs.writeFile(
      hook,
      '#!/bin/sh\nprintf "# Hook lost protected human\\n" > knowledge/index.md\ngit add -- knowledge/index.md\n',
      { mode: 0o755 },
    );
    const report = await syncRun(root, options);
    expect(report.integrateError).not.toBeNull();
    expect(report.commits.length).toBeGreaterThan(0);
    expect(report.pushed).toBe(false);
    expect((await git(remote, 'rev-parse', 'main')).trim()).toBe(incoming);
    expect((await git(root, 'rev-parse', 'HEAD')).trim()).not.toBe(incoming);
    expect((await lockApi.inspectRecoveryEvidence(join(root, '.git'))).length).toBeGreaterThan(0);
  }, 30_000);
  it.each(['same-oid-branch', 'attributes'])(
    'rejects a live post-merge hook changing %s after the actual FF and before any own commit',
    async (kind) => {
      await scenario();
      const program =
        kind === 'same-oid-branch'
          ? '#!/bin/sh\ngit branch switched\ngit symbolic-ref HEAD refs/heads/switched\n'
          : '#!/bin/sh\nprintf "knowledge/index.md filter=strip\\n" > .git/info/attributes\n';
      await fs.writeFile(join(root, '.git/hooks/post-merge'), program, { mode: 0o755 });
      const report = await syncRun(root, options);
      expect(report.integrateError).not.toBeNull();
      expect(report.commits).toEqual([]);
      expect(report.pushed).toBe(false);
      expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(incoming);
      expect(await fs.readFile(join(root, output), 'utf8')).toBe(
        await git(clone, 'show', `${incoming}:${output}`),
      );
      expect((await git(remote, 'rev-parse', 'main')).trim()).toBe(incoming);
      expect((await lockApi.inspectRecoveryEvidence(join(root, '.git'))).length).toBeGreaterThan(0);
    },
    30_000,
  );
  it('stops after a real target rename/completion-fsync fault with prior durable intent and no first commit/push', async () => {
    await scenario();
    let injected = false;
    const report = await syncRun(root, options, {
      boundary: async (edge) => {
        if (edge === 'target.parent.fsync:before' && !injected) {
          injected = true;
          throw Object.assign(new Error('wiring fsync fault'), { code: 'EIO' });
        }
      },
    });
    expect(injected).toBe(true);
    expect(report.integrateError).toContain('wiring fsync fault');
    expect(report.commits).toEqual([]);
    expect(report.pushed).toBe(false);
    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(initial);
    expect((await lockApi.inspectRecoveryEvidence(join(root, '.git'))).length).toBeGreaterThan(0);
  }, 30_000);
  it('warms a same-content external stat change across FF even without an executable hook', async () => {
    await scenario();
    const untouched = join(root, 'knowledge/untouched/index.md');
    await fs.mkdir(join(root, 'knowledge/untouched'));
    await fs.writeFile(untouched, '# Untouched human\n');
    await settle(untouched);
    const merge = gitApi.ffOnlyMerge;
    vi.spyOn(gitApi, 'ffOnlyMerge').mockImplementation(async (...args) => {
      const result = await merge(...args);
      await fs.utimes(untouched, new Date(), new Date());
      return result;
    });
    const first = await syncRun(root, options);
    expect(first.integrateError).toBeNull();
    expect(first.indexesDeferred).toBe(true);
    expect(first.commits).toEqual([]);
    const deferred = await readRecoveryManifest(join(root, '.git/condash-index-recovery/active'));
    expect(deferred.checkout?.opaqueHook).toBe(false);
    expect(
      deferred.paths.find((path) => path.protection.path === 'knowledge/untouched/index.md')!
        .eligibleAtMs,
    ).toBeGreaterThan(deferred.invocation.cutoffMs);
    expect(await fs.readFile(untouched, 'utf8')).toBe('# Untouched human\n');
    const second = await syncRun(root, options);
    expect(second.integrateError).toBeNull();
    expect(second.pushed).toBe(true);
    expect(gitApi.ffOnlyMerge).toHaveBeenCalledTimes(1);
  }, 30_000);
  it('refuses an ambiguous configured push destination before normalization', async () => {
    await scenario();
    await git(root, 'config', 'remote.origin.push', 'refs/heads/main:refs/heads/other');
    const report = await syncRun(root, options);
    expect(report.integrateError).toContain('unambiguous upstream push destination');
    expect(report.commits).toEqual([]);
    expect(report.pushed).toBe(false);
    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(initial);
    expect(await fs.readFile(join(root, output), 'utf8')).toBe(local);
  }, 30_000);
  it('rejects a post-commit tree-only protected-output substitution despite an unchanged live index/worktree', async () => {
    await scenario();
    await fs.writeFile(
      join(root, '.git/hooks/post-commit'),
      `#!/bin/sh
blob=$(printf '# Tree-only lost human\\n' | git hash-object -w --stdin)
GIT_INDEX_FILE=.git/fixture-tree-index git read-tree HEAD
GIT_INDEX_FILE=.git/fixture-tree-index git update-index --add --cacheinfo 100644 "$blob" knowledge/index.md
tree=$(GIT_INDEX_FILE=.git/fixture-tree-index git write-tree)
parent=$(git rev-parse HEAD^)
commit=$(printf 'fixture tree-only substitution\\n' | git commit-tree "$tree" -p "$parent")
git update-ref HEAD "$commit"
`,
      { mode: 0o755 },
    );
    const report = await syncRun(root, options);
    expect(report.integrateError).toMatch(
      /Actual recovery commit tree differs|Recovery refuses staged deltas/,
    );
    expect(report.commits).toHaveLength(1);
    expect(report.pushed).toBe(false);
    expect(await fs.readFile(join(root, output), 'utf8')).toContain('# Human');
    expect(await git(root, 'show', 'HEAD:knowledge/index.md')).toBe('# Tree-only lost human\n');
    expect((await git(remote, 'rev-parse', 'main')).trim()).toBe(incoming);
  }, 30_000);
  it('reports an observed local commit when the commit command fails after its actual effect', async () => {
    await scenario();
    vi.spyOn(gitApi, 'commitPaths').mockImplementation(
      async (directory, paths, subject, checkpoints) => {
        await checkpoints!.beforeAdd(paths);
        await git(directory, 'add', '-A', '--', ...paths);
        await checkpoints!.afterAdd(paths);
        await checkpoints!.beforeCommit(paths);
        await git(directory, 'commit', '--only', '-qm', subject, '--', ...paths);
        throw new Error('injected lost command response after actual commit');
      },
    );
    const report = await syncRun(root, options);
    const actual = (await git(root, 'rev-parse', 'HEAD')).trim();
    expect(actual).not.toBe(incoming);
    expect(report.integrateError).toContain(`observedLocalCommits=${actual}`);
    expect(report.integrateError).toContain('verifiedCommits=0');
    expect(report.pushed).toBe(false);
    expect((await git(remote, 'rev-parse', 'main')).trim()).toBe(incoming);
    expect(
      (
        JSON.parse(
          await fs.readFile(join(root, '.git/condash-index-recovery/active/manifest.json'), 'utf8'),
        ) as { intents: { kind: string; status: string }[] }
      ).intents.some((intent) => intent.kind === 'commit' && intent.status === 'pending'),
    ).toBe(true);
  }, 30_000);
  it('reports a verified push honestly when later outcome publication fails', async () => {
    await scenario();
    const report = await syncRun(root, options, {
      boundary: async (edge) => {
        if (edge === 'manifest.complete.rename:before')
          throw new Error('outcome publication fault');
      },
    });
    expect(report.integrateError).toContain('outcome publication fault');
    expect(report.integrateError).toContain('push=pushed');
    expect(report.pushed).toBe(true);
    expect(report.commits.length).toBeGreaterThan(0);
    expect(await git(remote, 'rev-parse', 'main')).toBe(await git(root, 'rev-parse', 'HEAD'));
    expect((await lockApi.inspectRecoveryEvidence(join(root, '.git'))).length).toBeGreaterThan(0);
  }, 30_000);

  it.each(['journal-root.mkdir:after', 'journal-active.mkdir:after', 'token.purpose.fsync:before'])(
    'transfers cleanup before a possibly effective bootstrap operation at %s',
    async (edge) => {
      await scenario();
      const before = await fs.readFile(join(root, output));
      const report = await syncRun(root, options, {
        boundary: async (point) => {
          if (point === edge) throw new Error('bootstrap return-gap fault');
          if (point === 'emergency-error.open:before') throw new Error('emergency ENOSPC');
        },
      });
      expect(report.integrateError).toContain('manual reconciliation required');
      expect(report.commits).toEqual([]);
      expect(report.pushed).toBe(false);
      expect(await fs.readFile(join(root, output))).toEqual(before);
      expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(initial);
      expect(await fs.stat(join(root, '.git/condash-sync.lock'))).toBeDefined();
      await expect(syncRun(root, options)).rejects.toBeInstanceOf(SyncRefusedError);
    },
    30_000,
  );

  it('releases the ordinary lock when a pre-evidence journal-create check fails, and the next sweep proceeds', async () => {
    await scenario();
    const before = await fs.readFile(join(root, output));
    // A wrong umask fails RecoveryJournal.create's provably non-mutating
    // checks; with the fix they run before the cleanup transfer, so the
    // ordinary lock is released normally instead of blocking a live sweeper
    // up to the stale window.
    const savedUmask = process.umask(0o077);
    let report;
    try {
      report = await syncRun(root, options);
    } finally {
      process.umask(savedUmask);
    }
    expect(report.integrateError).toContain('refused before normalization');
    expect(report.integrateError).toContain('0644 Git checkout umask');
    expect(report.commits).toEqual([]);
    expect(report.pushed).toBe(false);
    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(initial);
    expect(await fs.readFile(join(root, output))).toEqual(before);
    // Pre-evidence: no journal exists, and the lock is gone.
    expect(await lockApi.inspectRecoveryEvidence(join(root, '.git'))).toEqual([]);
    await expect(fs.stat(join(root, '.git/condash-sync.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const next = await syncRun(root, options);
    expect(next.integrateError).toBeNull();
    expect(next.pushed).toBe(true);
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
  }, 90_000);

  it('releases the ordinary lock when a hoisted read-only create check fails, and the next sweep proceeds', async () => {
    await scenario();
    const before = await fs.readFile(join(root, output));
    // Round 2: the four read-only create-time checks (directoryChain,
    // checkedDirectory ×2, checkGit) run before the cleanup transfer too.
    // The existing verifyGit hook seam injects the checkGit failure — no new
    // harness machinery.
    let calls = 0;
    const report = await syncRun(root, options, {
      verifyGit: async () => {
        calls++;
        throw new Error('hoisted git-state fault');
      },
    });
    expect(calls).toBe(1);
    expect(report.integrateError).toContain('refused before normalization');
    expect(report.integrateError).toContain('hoisted git-state fault');
    expect(report.commits).toEqual([]);
    expect(report.pushed).toBe(false);
    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(initial);
    expect(await fs.readFile(join(root, output))).toEqual(before);
    expect(await lockApi.inspectRecoveryEvidence(join(root, '.git'))).toEqual([]);
    await expect(fs.stat(join(root, '.git/condash-sync.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const next = await syncRun(root, options);
    expect(next.integrateError).toBeNull();
    expect(next.pushed).toBe(true);
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
  }, 90_000);

  it.each([
    'token.release.unlink:after',
    'token.release.parent.fsync:before',
    'token.release.helper:before',
  ])(
    'reports actual completed commits/push and cleanup uncertainty after %s without poisoning the archive',
    async (edge) => {
      await scenario();
      let fired = false;
      const report = await syncRun(root, options, {
        boundary: async (point) => {
          if (point === edge) {
            fired = true;
            throw new Error('post-ack cleanup fault');
          }
          if (fired && point === 'emergency-error.open:before')
            throw new Error('forbidden emergency write');
        },
      });
      expect(fired).toBe(true);
      expect(report.integrateError).toContain('cleanup uncertainty');
      expect(report.integrateError).not.toContain('manual reconciliation required');
      expect(report.pushed).toBe(true);
      expect(report.commits).toHaveLength(2);
      expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(
        (await git(remote, 'rev-parse', 'main')).trim(),
      );
      expect(await lockApi.inspectRecoveryEvidence(join(root, '.git'))).toEqual([]);
      await fs.writeFile(join(root, 'after-cleanup.txt'), 'ordinary next invocation\n');
      const next = await syncRun(root, options);
      expect(next.integrateError).toBeNull();
      expect(await git(remote, 'show', 'main:after-cleanup.txt')).toBe(
        'ordinary next invocation\n',
      );
    },
    90_000,
  );
});

describe('early unfinished-recovery entry gate', () => {
  let root: string;
  let gitDir: string;
  let evidence: string;
  beforeEach(async () => {
    root = await makeGitConception();
    gitDir = join(root, '.git');
    evidence = join(gitDir, 'condash-index-recovery');
    await fs.writeFile(join(root, 'knowledge/index.md'), '# Protected human\n');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function assertRefused(entry: () => Promise<unknown>, expected: RegExp): Promise<Error> {
    const status = vi.spyOn(gitApi, 'readChangedPaths');
    const fetch = vi.spyOn(gitApi, 'fetchUpstream');
    const acquire = vi.spyOn(lockApi, 'acquireSyncLock');
    const index = await fs.readFile(join(gitDir, 'index'));
    const protectedBytes = await fs.readFile(join(root, 'knowledge/index.md'));
    const head = await git(root, 'rev-parse', 'HEAD');
    const error = await entry().then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SyncRefusedError);
    expect((error as Error).message).toMatch(expected);
    expect(status).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(await fs.readFile(join(gitDir, 'index'))).toEqual(index);
    expect(await fs.readFile(join(root, 'knowledge/index.md'))).toEqual(protectedBytes);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    return error as Error;
  }

  it.each([
    'run',
    'no-push',
    'dry-run',
    'off',
    'safe-merge',
    'invalid-quiet',
    'milestone',
    'milestone-no-push',
    'milestone-dry-run',
    'milestone-off',
  ])(
    'refuses %s before status/fetch/ordinary-lock routing for missing authoritative metadata',
    async (invocation) => {
      await fs.mkdir(join(evidence, 'active'), { recursive: true, mode: 0o700 });
      const staleLock = join(gitDir, 'condash-sync.lock');
      await fs.writeFile(
        staleLock,
        JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() }),
      );
      await fs.utimes(staleLock, new Date(0), new Date(0));
      const before = await fs.readFile(staleLock);
      const identity = await fs.stat(staleLock, { bigint: true });
      const options = {
        ...RUN_DEFAULTS,
        push: invocation !== 'no-push' && invocation !== 'milestone-no-push',
        dryRun: invocation === 'dry-run' || invocation === 'milestone-dry-run',
        integration:
          invocation === 'off' || invocation === 'milestone-off'
            ? ('off' as const)
            : invocation === 'safe-merge'
              ? ('safe-merge' as const)
              : ('ff-only' as const),
        quietPeriodSeconds: invocation === 'invalid-quiet' ? Number.NaN : 0,
      };
      const error = await assertRefused(
        () =>
          invocation.startsWith('milestone')
            ? syncCommit(root, 'projects/2026-07/2026-07-10-alpha', 'fixture milestone', options)
            : syncRun(root, options),
        /Unresolved index recovery.*manual reconciliation/,
      );
      expect(error.message).toContain('authoritative metadata/evidence invalid or incomplete');
      expect(error.message).toContain(JSON.stringify(join(evidence, 'active')));
      expect(await fs.readFile(staleLock)).toEqual(before);
      expect((await fs.stat(staleLock, { bigint: true })).ino).toBe(identity.ino);
      expect((await fs.stat(staleLock, { bigint: true })).mtimeNs).toBe(0n);
      await expect(fs.stat(join(gitDir, 'FETCH_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
    20_000,
  );

  it.each(['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])(
    'never lets %s retarget status/index writes around the root journal gate',
    async (key) => {
      await fs.mkdir(join(evidence, 'active'), { recursive: true, mode: 0o700 });
      await assertRefused(async () => {
        const saved = process.env[key];
        process.env[key] = join(gitDir, 'fixture-redirection');
        try {
          return await syncRun(root, RUN_DEFAULTS);
        } finally {
          if (saved === undefined) delete process.env[key];
          else process.env[key] = saved;
        }
      }, /root\/index redirection is unsupported/);
    },
  );

  it.each(['partial-main', 'invalid-main', 'pending-archive', 'header-only-terminal'])(
    'retains and diagnoses %s without treating it as absent or resolved',
    async (shape) => {
      const location =
        shape.endsWith('archive') || shape === 'header-only-terminal'
          ? join(evidence, 'resolved', 'a'.repeat(32))
          : join(evidence, 'active');
      await fs.mkdir(location, { recursive: true, mode: 0o700 });
      const bytes =
        shape === 'partial-main'
          ? '{'
          : JSON.stringify({
              version: 1,
              generation: 2,
              owner: { nonce: 'b'.repeat(32) },
              phase:
                shape === 'header-only-terminal'
                  ? 'archived'
                  : shape === 'pending-archive'
                    ? 'archive-pending'
                    : 'preparing',
            });
      await fs.writeFile(join(location, 'manifest.json'), bytes, { mode: 0o600 });
      await assertRefused(
        () => syncRun(root, { ...RUN_DEFAULTS, push: true, quietPeriodSeconds: 0 }),
        /Unresolved index recovery/,
      );
      expect(await fs.readFile(join(location, 'manifest.json'), 'utf8')).toBe(bytes);
      await expect(fs.stat(join(gitDir, 'condash-sync.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
    20_000,
  );

  it.each(['valid-active', 'missing-immutable'])(
    'diagnoses %s without changing authoritative evidence or ordinary state',
    async (shape) => {
      await git(root, 'config', 'core.autocrlf', 'false');
      const remote = join(root, '.git/fixture-remote.git');
      await git(root, 'init', '--bare', '-q', '-b', 'main', remote);
      await git(root, 'remote', 'add', 'origin', remote);
      await git(root, 'push', '-q', '-u', 'origin', 'main');
      const limits = { maxBytes: 8 * 1024 * 1024, maxEntries: 100_000 };
      const state = await gitApi.readRecoveryGitState(root, limits);
      const acquired = await lockApi.acquireSyncLock(gitDir);
      if (!acquired.acquired) throw new Error('Fixture lock unavailable');
      const lease = await lockApi.promoteSyncLock(acquired.lock);
      const journal = await RecoveryJournal.create({
        root,
        gitDir,
        lock: acquired.lock,
        lease,
        state,
        invocation: {
          kind: 'syncRun',
          dryRun: false,
          push: true,
          integration: 'ff-only',
          quietPeriodSeconds: 90,
          cutoffMs: Date.now() - 90_000,
        },
      });
      await journal.addPath({
        path: 'knowledge/index.md',
        role: 'source',
        incoming: 'unchanged',
        head: null,
        incomingBytes: null,
        eligibleAtMs: 0,
      });
      await journal.releaseForManualReconciliation();
      const manifest = await readRecoveryManifest(journal.directory);
      const originalManifest = await fs.readFile(join(journal.directory, 'manifest.json'));
      const retainedPath = join(gitDir, 'fixture-retained-immutable-evidence.bin');
      if (shape === 'missing-immutable')
        await fs.rename(join(journal.directory, manifest.data[0].file), retainedPath);
      const error = await assertRefused(
        () =>
          syncCommit(root, 'projects/2026-07/2026-07-10-alpha', 'blocked milestone', {
            dryRun: false,
            push: false,
            integration: 'off',
          }),
        /phase="preparing"/,
      );
      expect(error.message).toContain(`generation=${manifest.generation}`);
      if (shape === 'valid-active') {
        expect(error.message).toContain(`expectedHEAD=${state.head}`);
        expect(error.message).toContain('pending=0');
      } else {
        expect(error.message).toContain('authoritative metadata/evidence invalid or incomplete');
        expect(await fs.readFile(retainedPath)).toEqual(Buffer.from('# Protected human\n'));
      }
      expect(await fs.readFile(join(journal.directory, 'manifest.json'))).toEqual(originalManifest);
    },
    20_000,
  );

  it('quotes hostile private paths and bounds diagnostics without opening a partial record as authority', async () => {
    const location = join(evidence, 'resolved', 'bad\narchive');
    await fs.mkdir(location, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(location, 'manifest.json'), '{');
    const error = await assertRefused(
      () => syncRun(root, RUN_DEFAULTS),
      /Unresolved index recovery/,
    );
    expect(error.message).toContain('bad\\narchive');
    expect(error.message.split('\n').length).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(4096);
  }, 20_000);
});

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
  const root = await fs.mkdtemp(join(fixtureParent, 'condash-sync-test-'));
  await fs.mkdir(join(root, 'projects'), { recursive: true });
  await fs.mkdir(join(root, 'knowledge'), { recursive: true });
  await fs.writeFile(
    join(root, '.gitignore'),
    ['projects/.index-dirty', 'knowledge/.index-dirty', 'projects/**/local/', ''].join('\n'),
  );

  await git(root, 'init', '-q', '-b', 'main');
  await fs.mkdir(join(root, '.git/hooks'), { recursive: true });
  await fs.mkdir(join(root, '.git/info'), { recursive: true });
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
  const clone = await fs.mkdtemp(join(fixtureParent, 'condash-sync-second-'));
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

  it.each([true, false])(
    'uses the original index mtime across a sweep rewrite (settled=%s)',
    async (settled) => {
      const alpha = await writeProjectReadme(root, 'alpha', {
        date: '2026-07-10',
        kind: 'project',
        status: 'now',
      });
      const beta = await writeProjectReadme(root, 'beta', {
        date: '2026-07-11',
        kind: 'project',
        status: 'now',
      });
      await settle(alpha, beta);
      await syncRun(root, RUN_DEFAULTS);
      await writeProjectReadme(root, 'alpha', {
        date: '2026-07-10',
        kind: 'project',
        status: 'done',
      });
      await regenerateIndex(root, projectsStrategy);
      await writeProjectReadme(root, 'beta', {
        date: '2026-07-11',
        kind: 'project',
        status: 'review',
      });
      const index = join(root, 'projects/2026-07/index.md');
      await settle(alpha, beta);
      if (settled) await settle(index);
      const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 300 });
      expect(
        report.commits.flatMap((commit) => commit.paths).includes('projects/2026-07/index.md'),
      ).toBe(settled);
      expect(report.skipped.some((entry) => entry.path === 'projects/2026-07/index.md')).toBe(
        !settled,
      );
      expect(await fs.readFile(index, 'utf8')).toContain('review');
    },
  );

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

    // The ordinary write-files-only close ritual: status flip + Closed. timeline entry.
    await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'done',
      body: [
        '## Timeline',
        '',
        '- 2026-07-10 — Opened.',
        '- 2026-07-12 — Closed. Did the thing.',
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

  it('commits a renamed item as one delete+add commit under the new subject', async () => {
    // Today a move lands as two commits a tick apart (deletions settle
    // immediately, additions sit out the quiet period), which breaks
    // `git log --follow`. A detected pair is one logical change: both sides
    // commit together, keyed by the new item, so rename detection connects
    // the history. The hand mv below keeps the `YYYY-MM-DD-` date prefix
    // and changes only the tail — the rename verb's exact shape, and the
    // shape the pairing constraint accepts.
    const readme = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
    });
    await fs.mkdir(join(root, 'projects', '2026-07', '2026-07-10-alpha', 'notes'));
    const note = join(root, 'projects', '2026-07', '2026-07-10-alpha', 'notes', '01-design.md');
    await fs.writeFile(note, '# design\n');
    await settle(readme, note);
    await syncRun(root, RUN_DEFAULTS);

    const oldDir = join(root, 'projects', '2026-07', '2026-07-10-alpha');
    const newDir = join(root, 'projects', '2026-07', '2026-07-10-beta');
    await fs.rename(oldDir, newDir);
    await settle(join(newDir, 'README.md'), join(newDir, 'notes', '01-design.md'));

    const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 3600 });

    expect(report.skipped).toEqual([]);
    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-beta: sync',
      'indexes: sync',
    ]);
    // One commit carries the deletion and the addition (`--no-renames` on the
    // show so git's own rename detection doesn't collapse the two into R).
    const nameStatus = await git(
      root,
      'show',
      '--name-status',
      '--format=',
      '--no-renames',
      'HEAD~1',
    );
    expect(nameStatus.trim().split('\n').sort()).toEqual([
      'A\tprojects/2026-07/2026-07-10-beta/README.md',
      'A\tprojects/2026-07/2026-07-10-beta/notes/01-design.md',
      'D\tprojects/2026-07/2026-07-10-alpha/README.md',
      'D\tprojects/2026-07/2026-07-10-alpha/notes/01-design.md',
    ]);

    // The point of the pairing: --follow walks old → new through the single
    // rename commit.
    const followed = await git(
      root,
      'log',
      '--follow',
      '--format=%s',
      '--',
      'projects/2026-07/2026-07-10-beta/README.md',
    );
    expect(followed.trim().split('\n')).toEqual([
      '2026-07-10-beta: sync',
      '2026-07-10-alpha: sync',
    ]);
  });

  it('holds back both sides of a rename until the new files settle', async () => {
    const readme = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
    });
    await settle(readme);
    await syncRun(root, RUN_DEFAULTS);

    const oldDir = join(root, 'projects', '2026-07', '2026-07-10-alpha');
    const newDir = join(root, 'projects', '2026-07', '2026-07-10-beta');
    await fs.rename(oldDir, newDir);
    // fs.rename preserves mtimes — the moved files would look settled from
    // the baseline. Force them fresh, the way the rename verb's own rewrites
    // of recently-touched files would.
    const now = new Date();
    await fs.utimes(join(newDir, 'README.md'), now, now);
    // The rename verb touches the dirty marker; with it pending, the held-back
    // tree's index work must defer too (an index over the new dir would point
    // at a directory this sweep refuses to commit).
    await fs.writeFile(join(root, 'projects', '.index-dirty'), '');

    const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 3600 });

    // The deletions are settled on their own but hold back with their partner:
    // committing a bare deletion now is the two-commit split this prevents.
    expect(report.commits).toEqual([]);
    expect(report.indexesDeferred).toBe(true);
    expect(report.skipped).toEqual([
      { path: 'projects/2026-07/2026-07-10-alpha/README.md', reason: 'quiet-period' },
      { path: 'projects/2026-07/2026-07-10-beta/README.md', reason: 'quiet-period' },
    ]);
    expect(await subjects(root)).toEqual(['indexes: sync', '2026-07-10-alpha: sync', 'init']);
  });

  it('sweeps a date-changing hand mv as two commits — the prefix constraint refuses to pair it', async () => {
    // A hand mv that changes the `YYYY-MM-DD-` prefix is outside the rename
    // verb's contract (the verb never moves the prefix), and pairing it
    // would merge an unrelated deletion with a coincidentally same-shaped
    // new item into one mislabelled commit. The date-prefix constraint is
    // why it stays unpaired: the deletion commits alongside the addition —
    // both settled here, so two item commits in one sweep instead of one.
    // Accepted trade-off; `git log --follow` breaks only for this shape.
    const readme = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
    });
    await fs.mkdir(join(root, 'projects', '2026-07', '2026-07-10-alpha', 'notes'));
    const note = join(root, 'projects', '2026-07', '2026-07-10-alpha', 'notes', '01-design.md');
    await fs.writeFile(note, '# design\n');
    await settle(readme, note);
    await syncRun(root, RUN_DEFAULTS);

    const oldDir = join(root, 'projects', '2026-07', '2026-07-10-alpha');
    const newDir = join(root, 'projects', '2026-07', '2026-07-11-alpha');
    await fs.rename(oldDir, newDir);
    await settle(join(newDir, 'README.md'), join(newDir, 'notes', '01-design.md'));

    const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 3600 });

    expect(report.skipped).toEqual([]);
    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      '2026-07-11-alpha: sync',
      'indexes: sync',
    ]);
    // Each commit is pure on its side — a bare deletion and a bare addition,
    // never one merged rename commit.
    const deletion = await git(
      root,
      'show',
      '--name-status',
      '--format=',
      '--no-renames',
      'HEAD~2',
    );
    expect(deletion.trim().split('\n')).toEqual([
      'D\tprojects/2026-07/2026-07-10-alpha/README.md',
      'D\tprojects/2026-07/2026-07-10-alpha/notes/01-design.md',
    ]);
    const addition = await git(
      root,
      'show',
      '--name-status',
      '--format=',
      '--no-renames',
      'HEAD~1',
    );
    expect(addition.trim().split('\n')).toEqual([
      'A\tprojects/2026-07/2026-07-11-alpha/README.md',
      'A\tprojects/2026-07/2026-07-11-alpha/notes/01-design.md',
    ]);
  });

  it('does not pair an unrelated deletion with a new item of a different shape', async () => {
    // Negative: the suffix sets differ, so this is a plain deletion plus an
    // unrelated new item — two separate commits, exactly the pre-pairing
    // behaviour.
    const readme = await writeProjectReadme(root, 'alpha', {
      date: '2026-07-10',
      kind: 'project',
      status: 'now',
    });
    await settle(readme);
    await syncRun(root, RUN_DEFAULTS);

    await fs.rm(readme); // deletion: suffix set {README.md}
    const gamma = await writeProjectReadme(root, 'gamma', {
      date: '2026-07-11',
      kind: 'project',
      status: 'now',
    });
    await fs.mkdir(join(root, 'projects', '2026-07', '2026-07-11-gamma', 'notes'));
    const gammaNote = join(root, 'projects', '2026-07', '2026-07-11-gamma', 'notes', '01-x.md');
    await fs.writeFile(gammaNote, '# x\n'); // new item: suffix set {README.md, notes/01-x.md}
    await settle(gamma, gammaNote);

    const report = await syncRun(root, { ...RUN_DEFAULTS, quietPeriodSeconds: 3600 });

    expect(report.commits.map((c) => c.subject)).toEqual([
      '2026-07-10-alpha: sync',
      '2026-07-11-gamma: sync',
      'indexes: sync',
    ]);
    const alphaDelete = await git(
      root,
      'show',
      '--name-status',
      '--format=',
      '--no-renames',
      'HEAD~2',
    );
    expect(alphaDelete.trim().split('\n')).toEqual([
      'D\tprojects/2026-07/2026-07-10-alpha/README.md',
    ]);
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
    const remote = await fs.mkdtemp(join(fixtureParent, 'condash-sync-remote-'));
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
    const remote = await fs.mkdtemp(join(fixtureParent, 'condash-sync-remote-'));
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
    const remote = await fs.mkdtemp(join(fixtureParent, 'condash-sync-remote-'));
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

  it('leaves local bytes, staged entries and HEAD unchanged when a fast-forward collides', async () => {
    const remote = await fs.mkdtemp(join(fixtureParent, 'condash-sync-remote-'));
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-q', '-u', 'origin', 'main');

    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'alpha');
    await git(root, 'push', '-q', 'origin', 'main');

    // A second session edits the same README and pushes.
    const clone = await fs.mkdtemp(join(fixtureParent, 'condash-sync-second-'));
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

    const head = await git(root, 'rev-parse', 'HEAD');
    const staged = await git(root, 'ls-files', '--stage', '-z');
    const report = await syncRun(root, { ...RUN_DEFAULTS, push: true });

    expect(report.integrateError).toContain('projects/2026-07/2026-07-10-alpha/README.md');
    expect(report.integrateError).toMatch(/fast-forward/i);
    expect(report.pushed).toBe(false);
    expect(report.diverged).toBe(false);
    expect(report.commits).toEqual([]);
    expect(report.regeneratedTrees).toEqual([]);
    expect(await fs.readFile(readme, 'utf8')).toBe('local edit\n');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'ls-files', '--stage', '-z')).toBe(staged);
    const next = await syncRun(root, { ...RUN_DEFAULTS, push: true });
    expect(next.commits).toEqual([]);
    expect(next.diverged).toBe(false);
    expect(next.ahead).toBe(0);
    expect(next.behind).toBe(1);
    const milestone = await syncCommit(root, 'projects/2026-07/2026-07-10-alpha', 'Milestone', {
      ...RUN_DEFAULTS,
      push: true,
    });
    expect(milestone.commits).toEqual([]);
    expect(milestone.integrateError).toContain('fast-forward failed');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);

    await fs.rm(remote, { recursive: true, force: true });
  });

  it('keeps a later observable index write warm after integration', async () => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);
    await syncRun(root, RUN_DEFAULTS);
    const indexPath = 'projects/2026-07/index.md';
    await fs.appendFile(join(root, indexPath), '\nLocal prose\n');
    await settle(join(root, indexPath));
    const remote = await fs.mkdtemp(join(fixtureParent, 'condash-sync-mtime-remote-'));
    try {
      await git(remote, 'init', '-q', '--bare', '-b', 'main');
      await git(root, 'remote', 'add', 'origin', remote);
      await git(root, 'push', '-q', '-u', 'origin', 'main');
      await advanceRemote(remote, root);
      await fs.writeFile(
        join(root, '.git/hooks/post-merge'),
        `#!/bin/sh\nprintf '\\nLater writer\\n' >> '${indexPath}'\n`,
        { mode: 0o755 },
      );
      const report = await syncRun(root, { ...RUN_DEFAULTS, push: true, quietPeriodSeconds: 300 });
      expect(report.integrateError).toBeNull();
      expect(report.behind).toBe(0);
      expect(report.commits).toEqual([]);
      expect(report.skipped).toContainEqual({ path: indexPath, reason: 'quiet-period' });
      expect(await fs.readFile(join(root, indexPath), 'utf8')).toContain('Later writer');
    } finally {
      await fs.rm(remote, { recursive: true, force: true });
    }
  });

  it.each(['run', 'commit'])('leaves dirty generated overlap retryable for %s', async (verb) => {
    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);
    await syncRun(root, RUN_DEFAULTS);
    const remote = await fs.mkdtemp(join(fixtureParent, 'condash-sync-overlap-remote-'));
    const clone = await fs.mkdtemp(join(fixtureParent, 'condash-sync-overlap-clone-'));
    try {
      await git(remote, 'init', '-q', '--bare', '-b', 'main');
      await git(root, 'remote', 'add', 'origin', remote);
      await git(root, 'push', '-q', '-u', 'origin', 'main');
      await git(root, 'clone', '-q', remote, clone);
      await git(clone, 'config', 'user.email', 'test@example.com');
      await git(clone, 'config', 'user.name', 'Test');
      const indexPath = 'projects/2026-07/index.md';
      await fs.appendFile(join(clone, indexPath), '\nRemote row\n');
      await git(clone, 'add', indexPath);
      await git(clone, 'commit', '-q', '-m', 'remote index');
      await git(clone, 'push', '-q');
      await fs.appendFile(join(root, indexPath), '\nLocal row\n');
      await fs.appendFile(readme, '\nLocal source\n');
      await fs.writeFile(join(root, 'projects/.index-dirty'), 'pending\n');
      await settle(readme, join(root, indexPath));
      await git(root, 'add', readme);
      const head = await git(root, 'rev-parse', 'HEAD');
      const staged = await git(root, 'ls-files', '--stage', '-z');
      const indexBytes = await fs.readFile(join(root, indexPath));
      const sourceBytes = await fs.readFile(readme);
      const remoteHead = await git(remote, 'rev-parse', 'HEAD');
      for (let attempt = 0; attempt < 2; attempt++) {
        const options = { ...RUN_DEFAULTS, push: true };
        const report =
          verb === 'run'
            ? await syncRun(root, options)
            : await syncCommit(root, 'projects/2026-07/2026-07-10-alpha', 'Milestone', options);
        expect(report.integrateError).toContain(indexPath);
        expect(report.commits).toEqual([]);
        expect(report.regeneratedTrees).toEqual([]);
        expect(report.pushed).toBe(false);
        expect(report.ahead).toBe(0);
        expect(report.behind).toBe(1);
        expect(report.diverged).toBe(false);
        expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
        expect(await git(root, 'ls-files', '--stage', '-z')).toBe(staged);
        expect(await fs.readFile(join(root, indexPath))).toEqual(indexBytes);
        expect(await fs.readFile(readme)).toEqual(sourceBytes);
        expect(await fs.readFile(join(root, 'projects/.index-dirty'), 'utf8')).toBe('pending\n');
        expect(await git(remote, 'rev-parse', 'HEAD')).toBe(remoteHead);
      }
    } finally {
      await fs.rm(clone, { recursive: true, force: true });
      await fs.rm(remote, { recursive: true, force: true });
    }
  });

  it('reports a failed fetch and gates both sweep and milestone commits', async () => {
    const remote = await fs.mkdtemp(join(fixtureParent, 'condash-sync-remote-'));
    await git(remote, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-q', '-u', 'origin', 'main');
    // Someone else moved the remote on: our fetch now fails.
    await fs.rm(remote, { recursive: true, force: true });

    const readme = await writeProjectReadme(root, 'alpha', { date: '2026-07-10', kind: 'project' });
    await settle(readme);

    const head = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'add', readme);
    const staged = await git(root, 'ls-files', '--stage', '-z');
    const sourceBytes = await fs.readFile(readme);
    await fs.writeFile(join(root, 'projects/index.md'), 'local index\n');
    await fs.writeFile(join(root, 'projects/.index-dirty'), 'pending\n');
    const report = await syncRun(root, { ...RUN_DEFAULTS, push: true });

    expect(report.commits).toEqual([]);
    expect(report.regeneratedTrees).toEqual([]);
    expect(report.pushed).toBe(false);
    expect(report.pushError).toBeNull();
    expect(report.integrateError).toBeTruthy();
    expect(report.integrateError).toMatch(/fetch failed/i);
    const milestone = await syncCommit(root, 'projects/2026-07/2026-07-10-alpha', 'Milestone', {
      ...RUN_DEFAULTS,
      push: true,
    });
    expect(milestone.commits).toEqual([]);
    expect(milestone.regeneratedTrees).toEqual([]);
    expect(milestone.integrateError).toContain('fetch failed');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'ls-files', '--stage', '-z')).toBe(staged);
    expect(await fs.readFile(readme)).toEqual(sourceBytes);
    expect(await fs.readFile(join(root, 'projects/index.md'), 'utf8')).toBe('local index\n');
    expect(await fs.readFile(join(root, 'projects/.index-dirty'), 'utf8')).toBe('pending\n');
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
    const remote = await fs.mkdtemp(join(fixtureParent, 'condash-sync-remote-'));
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
    const remote = await fs.mkdtemp(join(fixtureParent, 'condash-sync-remote-'));
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
