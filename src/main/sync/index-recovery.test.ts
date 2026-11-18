import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECOVERY_LIMITS,
  RecoveryBudget,
  RecoveryJournal,
  adoptRecoveryProtection,
  assertRecoveryRequirements,
  extendRecoveryProtection,
  prepareRecoveryProtection,
  recoveryCandidateQualifies,
  recoveryProtectedSpans,
  observeRecoveryFile,
  readRecoveryManifest,
  validateRecoveryManifest,
  inspectManualRecovery,
  selectRecoveryCandidatePaths,
  type RecoveryPersistenceHooks,
} from './index-recovery';
import {
  acquireSyncLock,
  inspectRecoveryEvidence,
  promoteSyncLock,
  readSyncLockToken,
  type RecoveryLease,
  type SyncLock,
  type SyncLockToken,
} from './lock';
import type { RecoveryGitState, RecoveryGitChange, ChangedPath } from './git';
import { readRecoveryGitState, ffOnlyMerge } from './git';

const bytes = (text: string) => Buffer.from(text);
const draft = '- [old](old.md) — *Stale*. <!-- draft -->';

describe('all-or-nothing structural recovery overlap selection', () => {
  function fixture(path = 'knowledge/index.md') {
    const local: ChangedPath[] = [{ path, conflicted: false, newToHead: false, deleted: false }];
    const incoming: RecoveryGitChange[] = [
      {
        path,
        status: 'M',
        oldMode: '100644',
        newMode: '100644',
        oldOid: 'a'.repeat(40),
        newOid: 'b'.repeat(40),
      },
    ];
    const state = {
      entries: [{ path, mode: '100644', oid: 'a'.repeat(40), stage: 0, flag: 'H', flags: '0' }],
      staged: '',
    } as RecoveryGitState;
    return { local, incoming, state, outputs: new Set([path]) };
  }
  it('selects exact W modifications while allowing unrelated dirty source deletion, binaries and incoming topology', () => {
    const item = fixture();
    item.local.push(
      { path: 'knowledge/body.md', deleted: true, newToHead: false, conflicted: false },
      { path: 'asset.bin', deleted: false, newToHead: false, conflicted: false },
    );
    item.incoming.push(
      {
        ...item.incoming[0],
        path: 'unrelated/new/body.md',
        status: 'A',
        oldMode: '000000',
        oldOid: '0'.repeat(40),
      },
      { ...item.incoming[0], path: 'knowledge/index.md.backup', status: 'D' },
    );
    expect(
      selectRecoveryCandidatePaths(item.local, item.incoming, item.outputs, item.state),
    ).toEqual(['knowledge/index.md']);
  });
  it.each([
    'local-add',
    'local-delete',
    'conflicted',
    'incoming-add',
    'incoming-delete',
    'type-change',
    'executable',
    'not-in-W',
    'staged',
    'hidden-flags',
    'unknown-flags',
    'unproved-H-blob',
    'ancestor-collision',
    'descendant-collision',
  ])(
    'refuses the complete batch for %s rather than returning its supported subset',
    (unsupported) => {
      const first = fixture();
      const second = fixture('projects/index.md');
      if (unsupported === 'local-add') second.local[0].newToHead = true;
      if (unsupported === 'local-delete') second.local[0].deleted = true;
      if (unsupported === 'conflicted') second.local[0].conflicted = true;
      if (unsupported === 'incoming-add') second.incoming[0].status = 'A';
      if (unsupported === 'incoming-delete') second.incoming[0].status = 'D';
      if (unsupported === 'type-change') second.incoming[0].status = 'T';
      if (unsupported === 'executable') second.incoming[0].newMode = '100755';
      if (unsupported === 'not-in-W') second.outputs.clear();
      if (unsupported === 'staged') second.state.staged = 'actual staged observation';
      if (unsupported === 'hidden-flags') second.state.entries[0].flags = '40000000';
      if (unsupported === 'unknown-flags') second.state.entries[0].flags = 'unknown';
      if (unsupported === 'unproved-H-blob') second.state.entries[0].oid = 'c'.repeat(40);
      if (unsupported === 'ancestor-collision') second.incoming[0].path = 'projects';
      if (unsupported === 'descendant-collision')
        second.incoming[0].path = 'projects/index.md/child';
      const local = [...first.local, ...second.local];
      const incoming = [...first.incoming, ...second.incoming];
      const state = {
        ...first.state,
        entries: [...first.state.entries, ...second.state.entries],
        staged: second.state.staged,
      };
      const outputs = new Set([...first.outputs, ...second.outputs]);
      const before = JSON.stringify({ local, incoming, state });
      expect(() => selectRecoveryCandidatePaths(local, incoming, outputs, state)).toThrow(
        'Unsupported local/incoming recovery overlap',
      );
      expect(JSON.stringify({ local, incoming, state })).toBe(before);
    },
  );
  it('returns no recovery selection when no local path overlaps the incoming delta', () => {
    const item = fixture();
    item.incoming[0].path = 'knowledge/unrelated.md';
    expect(
      selectRecoveryCandidatePaths(item.local, item.incoming, item.outputs, item.state),
    ).toEqual([]);
  });
  it('enforces finite entry and candidate bounds before returning an oversized normalization batch', () => {
    const item = fixture();
    expect(() =>
      selectRecoveryCandidatePaths(
        Array(RECOVERY_LIMITS.entries + 1).fill(item.local[0]),
        item.incoming,
        item.outputs,
        item.state,
      ),
    ).toThrow('entry limit');
    const items = Array.from({ length: RECOVERY_LIMITS.candidates + 1 }, (_, index) =>
      fixture(`knowledge/folder-${index}/index.md`),
    );
    expect(() =>
      selectRecoveryCandidatePaths(
        items.flatMap((item) => item.local),
        items.flatMap((item) => item.incoming),
        new Set(items.flatMap((item) => [...item.outputs])),
        { ...item.state, entries: items.flatMap((item) => item.state.entries) },
      ),
    ).toThrow('candidate limit');
  });
});

describe('explicit reviewed manual restart resolution (real local Git)', () => {
  const path = 'knowledge/index.md';
  const original = bytes('# Human\n\n');
  const incoming = bytes('# Incoming\n\n');
  const local = bytes(`# Human\n\n${draft}\n`);
  let base: string;
  let root: string;
  let gitDir: string;
  let reviewDirectory: string;
  let lock: SyncLock;
  let lease: RecoveryLease;
  let owner: RecoveryJournal | null;
  let state: RecoveryGitState;
  let environment: NodeJS.ProcessEnv;
  let armed: string | null;
  let injected: boolean;
  let hooks: RecoveryPersistenceHooks;
  const git = (directory: string, ...args: string[]) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', env: process.env });

  beforeEach(async () => {
    environment = { ...process.env };
    base = await fs.mkdtemp(join(tmpdir(), 'condash-manual-resolution-'));
    root = join(base, 'root');
    reviewDirectory = join(base, 'review');
    await fs.mkdir(root);
    await fs.mkdir(reviewDirectory, { mode: 0o700 });
    await fs.mkdir(join(base, 'home'));
    await fs.mkdir(join(base, 'templates'));
    for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
    Object.assign(process.env, {
      HOME: join(base, 'home'),
      XDG_CONFIG_HOME: join(base, 'home/.config'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TEMPLATE_DIR: join(base, 'templates'),
    });
    git(root, 'init', '-qb', 'main');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'config', 'core.autocrlf', 'false');
    await fs.mkdir(join(root, 'knowledge'));
    await fs.mkdir(join(root, 'projects'));
    await fs.writeFile(join(root, path), original, { mode: 0o644 });
    await fs.writeFile(join(root, '.gitattributes'), '*.md -text\n');
    await fs.writeFile(join(root, '.gitignore'), 'knowledge/.index-dirty\nprojects/.index-dirty\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'seed manual fixture');
    const remote = join(base, 'remote.git');
    git(base, 'init', '--bare', '-qb', 'main', remote);
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-qu', 'origin', 'main');
    const other = join(base, 'other');
    git(base, 'clone', '-q', remote, other);
    git(other, 'config', 'user.name', 'Fixture');
    git(other, 'config', 'user.email', 'fixture@example.invalid');
    await fs.writeFile(join(other, path), incoming);
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'incoming manual fixture');
    git(other, 'push', '-q');
    git(root, 'fetch', '-q');
    await fs.writeFile(join(root, path), local);
    await fs.utimes(join(root, path), new Date(0), new Date(0));
    gitDir = join(root, '.git');
    state = await readRecoveryGitState(root, {
      maxBytes: RECOVERY_LIMITS.journalBytes,
      maxEntries: RECOVERY_LIMITS.entries,
    });
    const acquired = await acquireSyncLock(gitDir);
    if (!acquired.acquired) throw new Error('Fixture lock unavailable');
    lock = acquired.lock;
    lease = await promoteSyncLock(lock);
    owner = null;
    armed = null;
    injected = false;
    hooks = {
      boundary: async (edge) => {
        if (edge === armed && !injected) {
          injected = true;
          throw Object.assign(new Error(`manual injected ${edge}`), { code: 'EIO' });
        }
      },
    };
  });
  afterEach(async () => {
    if (owner) await owner.releaseForManualReconciliation().catch(() => {});
    await lease
      .assertOwned()
      .then(() => lock.release())
      .catch(() => {});
    await lease.close();
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
  });

  async function prepared(normalize = false): Promise<RecoveryJournal> {
    owner = await RecoveryJournal.create({
      root,
      gitDir,
      state,
      lock,
      lease,
      invocation: {
        kind: 'syncRun',
        dryRun: false,
        push: true,
        integration: 'ff-only',
        quietPeriodSeconds: 90,
        cutoffMs: Date.now() - 90_000,
      },
      hooks,
    });
    await owner.addPath({
      path,
      role: 'output',
      incoming: 'modified',
      head: original,
      incomingBytes: incoming,
      candidate: true,
      eligibleAtMs: 0,
    });
    await owner.prepare();
    if (normalize) await owner.normalizeCandidate(path, async () => {});
    return owner;
  }
  async function adopted(): Promise<RecoveryJournal> {
    const journal = await prepared(true);
    const merge = await journal.beginEffect('merge', { target: state.upstreamOid });
    expect(await ffOnlyMerge(root, state.upstreamOid)).toEqual({ ok: true });
    state = await readRecoveryGitState(root, {
      maxBytes: RECOVERY_LIMITS.journalBytes,
      maxEntries: RECOVERY_LIMITS.entries,
    });
    await journal.completeEffect(merge, state);
    await journal.adoptActual();
    return journal;
  }

  async function retireFixtureOwner(journal: RecoveryJournal): Promise<void> {
    await journal.releaseForManualReconciliation();
    // Model a persisted dead owner without removing its witness. Real owner kills are exercised separately.
    const dead = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          `
      const fs=require('node:fs'); const fields=fs.readFileSync('/proc/self/stat','utf8');
      console.log(JSON.stringify({pid:process.pid,bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),
        processStart:fields.slice(fields.lastIndexOf(')')+2).trim().split(/\\s+/)[19]}));
    `,
        ],
        { encoding: 'utf8' },
      ),
    );
    const token = await readSyncLockToken(gitDir);
    if (!token) throw new Error('Fixture witness unexpectedly absent');
    const retired = { ...token, ...dead };
    await fs.writeFile(join(gitDir, 'condash-sync.lock'), JSON.stringify(retired) + '\n');
    const manifest = join(journal.directory, 'manifest.json');
    const old = await fs.readFile(manifest);
    const record = JSON.parse(old.toString('utf8'));
    record.owner = retired;
    if (record.releasePrerequisite) record.releasePrerequisite.owner = retired;
    for (let iteration = 0; iteration < 8; iteration++) {
      const next = Buffer.from(JSON.stringify(record) + '\n');
      const delta = next.length - old.length;
      const used = JSON.parse(old.toString('utf8')).resources.usedBytes + delta;
      if (record.resources.usedBytes === used) break;
      record.resources.usedBytes = used;
    }
    await fs.writeFile(manifest, JSON.stringify(record) + '\n');
  }

  it('refuses live-owner administrative closure and only proposes reads while it is live', async () => {
    const journal = await prepared(true);
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(review.receipt).toBeNull();
    expect(review.blockers.join('\n')).toContain('still live');
    expect(
      review.operations.every((operation) => operation.argv[0] === 'git' && !operation.patch),
    ).toBe(true);
  }, 30_000);

  it.each([
    'manifest.manual-resolving.readback:before',
    'manifest.manual-resolving.published-parent.fsync:before',
    'token.create.open:before',
  ])(
    'keeps manual admission blocked across the administrative handoff fault %s',
    async (edge) => {
      const journal = await prepared();
      await retireFixtureOwner(journal);
      const retained = await fs.readFile(lock.path);
      const source = await fs.readFile(join(journal.directory, 'manifest.json'));
      const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
      expect(review.receipt).not.toBeNull();
      let fired = false;
      await expect(
        RecoveryJournal.resolveReviewed({
          receipt: review.receipt!,
          reviewDirectory,
          hooks: {
            boundary: async (point) => {
              if (point === edge) {
                fired = true;
                throw new Error('handoff fault');
              }
              if (point === 'emergency-error.open:before') throw new Error('emergency ENOSPC');
            },
          },
        }),
      ).rejects.toThrow('handoff fault');
      expect(fired).toBe(true);
      if (edge === 'token.create.open:before') {
        expect(await readSyncLockToken(gitDir)).toBeNull();
        const barrier = await readRecoveryManifest(journal.directory);
        expect(barrier.phase).toBe('resolving');
        expect(barrier.releasePrerequisite).toBeNull();
        const preserved = barrier.manualResolution!.sourceManifests[0];
        expect(await fs.readFile(join(journal.directory, preserved.file))).toEqual(source);
      } else expect(await fs.readFile(lock.path)).toEqual(retained);
      await expect(acquireSyncLock(gitDir)).rejects.toThrow('Unresolved index recovery');
    },
    30_000,
  );

  it('keeps a complete legacy archive inspect-only and preserves its original bytes through reviewed v2 closure', async () => {
    const journal = await adopted();
    await journal.finish(
      { head: state.head, commits: [], staged: '', push: 'not-attempted', protectedVerified: true },
      async () => {},
    );
    const manifestPath = join(journal.directory, 'manifest.json');
    const old = await fs.readFile(manifestPath);
    const record = JSON.parse(old.toString('utf8'));
    record.version = 1;
    delete record.releasePrerequisite;
    const oldUsed = record.resources.usedBytes;
    for (let iteration = 0; iteration < 8; iteration++) {
      const used = oldUsed + Buffer.byteLength(JSON.stringify(record) + '\n') - old.length;
      if (used === record.resources.usedBytes) break;
      record.resources.usedBytes = used;
    }
    const legacy = Buffer.from(JSON.stringify(record) + '\n');
    await fs.writeFile(manifestPath, legacy);
    await expect(acquireSyncLock(gitDir)).rejects.toThrow('Unresolved index recovery');
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(review.receipt).not.toBeNull();
    const result = await RecoveryJournal.resolveReviewed({
      receipt: review.receipt!,
      reviewDirectory,
    });
    const final = await readRecoveryManifest(result.directory);
    expect(final.version).toBe(2);
    expect(
      await fs.readFile(join(result.directory, final.manualResolution!.sourceManifests[0].file)),
    ).toEqual(legacy);
    expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
  }, 30_000);

  it.each([
    'manifest.candidate-intent.rename:before',
    'manifest.candidate-intent.published-parent.fsync:before',
  ])(
    'retains %s evidence and closes a verified no-target refusal without changing Git/index/worktree',
    async (failure) => {
      const journal = await prepared();
      armed = failure;
      await expect(journal.normalizeCandidate(path, async () => {})).rejects.toThrow(
        'manual injected',
      );
      await retireFixtureOwner(journal);
      const before = await fs.readFile(join(gitDir, 'index'));
      const worktree = await fs.readFile(join(root, path));
      const head = git(root, 'rev-parse', 'HEAD');
      const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
      expect(review.blockers).toEqual([]);
      expect(review.receipt).not.toBeNull();
      expect(
        review.inventory.files.some((entry) => entry.reference.file.startsWith('error-')),
      ).toBe(true);
      const result = await RecoveryJournal.resolveReviewed({
        receipt: review.receipt!,
        reviewDirectory,
      });
      expect(await fs.readFile(join(gitDir, 'index'))).toEqual(before);
      expect(await fs.readFile(join(root, path))).toEqual(worktree);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
      const terminal = await readRecoveryManifest(result.directory);
      expect(terminal.phase).toBe('archived');
      if (failure.endsWith('rename:before')) {
        expect(terminal.intents).toHaveLength(0);
        expect(
          terminal.preserved?.some(
            (reference) =>
              reference.file.startsWith('manifest-') && reference.file.endsWith('.tmp'),
          ),
        ).toBe(true);
      } else expect(terminal.intents[0].status).toBe('reconciled');
      expect(terminal.preserved?.some((reference) => reference.file.startsWith('error-'))).toBe(
        true,
      );
      for (const entry of review.inventory.files)
        expect(
          createHash('sha256')
            .update(await fs.readFile(join(result.directory, entry.reference.file)))
            .digest('hex'),
        ).toBe(entry.reference.sha256);
      expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
    },
    30_000,
  );

  it('provides a guarded owned-B patch for the user, then re-verifies the repaired state instead of replaying it', async () => {
    const journal = await prepared(true);
    await retireFixtureOwner(journal);
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(review.receipt).toBeNull();
    const operation = review.operations.find((operation) => operation.patch)!;
    expect(operation.expectedSha256).toBe(createHash('sha256').update(original).digest('hex'));
    const patchPath = operation.argv[operation.argv.length - 1];
    await fs.writeFile(patchPath, operation.patch!, { mode: 0o600 });
    execFileSync(operation.argv[0], operation.argv.slice(1), { env: process.env });
    const apply = review.operations.find((operation) =>
      operation.description.startsWith('Only after review'),
    )!;
    execFileSync(apply.argv[0], apply.argv.slice(1), { env: process.env });
    expect(await fs.readFile(join(root, path))).toEqual(local);
    const reconciled = await inspectManualRecovery({
      directory: journal.directory,
      reviewDirectory,
    });
    expect(reconciled.receipt).not.toBeNull();
    const result = await RecoveryJournal.resolveReviewed({
      receipt: reconciled.receipt!,
      reviewDirectory,
    });
    expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
    expect((await readRecoveryManifest(result.directory)).manualResolution?.reviews[0].epoch).toBe(
      'local',
    );
  }, 30_000);

  it('requires a reviewed orphan worktree-temp move and retains its exact bytes in the terminal journal', async () => {
    const journal = await prepared();
    armed = 'target.temporary.close:before';
    await expect(journal.normalizeCandidate(path, async () => {})).rejects.toThrow(
      'manual injected',
    );
    await retireFixtureOwner(journal);
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(review.receipt).toBeNull();
    const move = review.operations.find((operation) => operation.argv[0] === 'mv')!;
    const source = move.argv[move.argv.length - 2];
    const retained = move.argv[move.argv.length - 1];
    const hash = createHash('sha256')
      .update(await fs.readFile(source))
      .digest('hex');
    expect(hash).toBe(move.expectedSha256);
    const chmod = review.operations.find((operation) => operation.argv[0] === 'chmod')!;
    execFileSync(chmod.argv[0], chmod.argv.slice(1), { env: process.env });
    execFileSync(move.argv[0], move.argv.slice(1), { env: process.env });
    const reconciled = await inspectManualRecovery({
      directory: journal.directory,
      reviewDirectory,
    });
    expect(reconciled.receipt).not.toBeNull();
    const result = await RecoveryJournal.resolveReviewed({
      receipt: reconciled.receipt!,
      reviewDirectory,
    });
    const relativeArtifact = retained.slice(journal.directory.length + 1);
    expect(
      createHash('sha256')
        .update(await fs.readFile(join(result.directory, relativeArtifact)))
        .digest('hex'),
    ).toBe(hash);
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(join(root, path))).toEqual(local);
  }, 30_000);

  it('rejects forged receipts and stale concrete observations, with no approval-boolean escape', async () => {
    const journal = await prepared();
    await retireFixtureOwner(journal);
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    const forged = JSON.parse(JSON.stringify(review.receipt));
    forged.paths[0].requirements = [];
    const { digest: _old, ...facts } = forged;
    const canonical = JSON.parse(JSON.stringify(facts));
    for (const observation of [
      ...canonical.paths.map(
        (path: { observation: { identity: { atimeNs?: string } | null } }) => path.observation,
      ),
      ...(canonical.markers ?? []),
    ])
      if (observation.identity) delete observation.identity.atimeNs;
    if (canonical.ordinaryToken) delete canonical.ordinaryToken.identity.atimeNs;
    forged.digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    await expect(
      RecoveryJournal.resolveReviewed({
        receipt: forged,
        reviewDirectory,
        hooks: { verifyGit: async () => {} },
      }),
    ).rejects.toThrow('facts changed');
    await fs.appendFile(join(root, path), 'later protected addition\n');
    await expect(
      RecoveryJournal.resolveReviewed({ receipt: review.receipt!, reviewDirectory }),
    ).rejects.toThrow('facts changed');
    expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
  }, 30_000);

  it('ignores access-time diagnostics only, and persists source-derived observations rather than caller diagnostics', async () => {
    const journal = await prepared();
    await retireFixtureOwner(journal);
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    const receipt = JSON.parse(JSON.stringify(review.receipt));
    receipt.paths.find(
      (entry: { path: string }) => entry.path === path,
    ).observation.identity.atimeNs = '1';
    const result = await RecoveryJournal.resolveReviewed({ receipt, reviewDirectory });
    const terminal = await readRecoveryManifest(result.directory);
    expect(
      terminal.manualResolution?.reviews[0].paths.find((entry) => entry.path === path)?.observation
        .identity?.atimeNs,
    ).not.toBe('1');
  }, 30_000);

  it('rejects observable marker drift and retains the newly reviewed marker without clearing it', async () => {
    const journal = await prepared();
    await retireFixtureOwner(journal);
    const marker = join(root, 'knowledge/.index-dirty');
    await fs.writeFile(marker, '', { mode: 0o644 });
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    await fs.utimes(marker, new Date(0), new Date(0));
    await expect(
      RecoveryJournal.resolveReviewed({ receipt: review.receipt!, reviewDirectory }),
    ).rejects.toThrow('facts changed');
    const renewed = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    const result = await RecoveryJournal.resolveReviewed({
      receipt: renewed.receipt!,
      reviewDirectory,
    });
    expect((await fs.stat(marker, { bigint: true })).mtimeNs).toBe(0n);
    expect(await fs.readFile(marker)).toEqual(Buffer.alloc(0));
    expect(
      (await readRecoveryManifest(result.directory)).markers.find(
        (entry) => entry.path === 'knowledge/.index-dirty',
      )?.identity?.mtimeNs,
    ).toBe('0');
  }, 30_000);

  it('never treats an unreadable/partial main manifest as manual closure authority', async () => {
    const journal = await prepared();
    await retireFixtureOwner(journal);
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    await fs.writeFile(join(journal.directory, 'manifest.json'), '{');
    await expect(
      RecoveryJournal.resolveReviewed({ receipt: review.receipt!, reviewDirectory }),
    ).rejects.toThrow();
    expect(await fs.readFile(join(journal.directory, 'manifest.json'), 'utf8')).toBe('{');
    expect(await fs.readFile(join(root, path))).toEqual(local);
    expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
  }, 30_000);

  it.each(['manifest.manual-claim.rename:after', 'manifest.manual-resolved.rename:after'])(
    're-inspects and retains previous manual requirements after interrupted %s',
    async (failure) => {
      const journal = await prepared();
      await retireFixtureOwner(journal);
      const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
      let fired = false;
      await expect(
        RecoveryJournal.resolveReviewed({
          receipt: review.receipt!,
          reviewDirectory,
          hooks: {
            boundary: async (edge) => {
              if (edge === failure && !fired) {
                fired = true;
                throw new Error('interrupted manual publication');
              }
            },
          },
        }),
      ).rejects.toThrow('interrupted manual publication');
      await retireFixtureOwner(journal);
      const renewed = await inspectManualRecovery({
        directory: journal.directory,
        reviewDirectory,
      });
      expect(renewed.receipt).not.toBeNull();
      const result = await RecoveryJournal.resolveReviewed({
        receipt: renewed.receipt!,
        reviewDirectory,
      });
      const terminal = await readRecoveryManifest(result.directory);
      expect(terminal.manualResolution!.reviews).toHaveLength(2);
      expect(terminal.manualResolution!.sourceManifests).toHaveLength(2);
      expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
    },
    30_000,
  );

  it('never drops newly recorded manual protected spans after a failed administrative claim', async () => {
    const journal = await prepared();
    await retireFixtureOwner(journal);
    await fs.appendFile(join(root, path), 'newly reviewed human span\n');
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    await expect(
      RecoveryJournal.resolveReviewed({
        receipt: review.receipt!,
        reviewDirectory,
        hooks: {
          boundary: async (edge) => {
            if (edge === 'manual.after-claim') throw new Error('stop after durable manual claim');
          },
        },
      }),
    ).rejects.toThrow('stop after durable manual claim');
    await retireFixtureOwner(journal);
    await fs.writeFile(join(root, path), local);
    const rejected = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(rejected.receipt).toBeNull();
    expect(rejected.blockers.join('\n')).toContain('sequence lost');
    await fs.appendFile(join(root, path), 'newly reviewed human span\n');
    const renewed = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    const result = await RecoveryJournal.resolveReviewed({
      receipt: renewed.receipt!,
      reviewDirectory,
    });
    expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
    expect((await readRecoveryManifest(result.directory)).manualResolution?.reviews).toHaveLength(
      2,
    );
  }, 30_000);

  it('checks actual pending staged objects and preserves the exact binary index instead of resetting it', async () => {
    const journal = await adopted();
    const generated = bytes('# Incoming\n\nGenerated retained prose\n');
    await journal.applyOutput(path, incoming, generated, async () => {});
    await journal.beginEffect('stage', { paths: [path] });
    git(root, 'add', '-A', '--', path);
    await retireFixtureOwner(journal);
    const before = await fs.readFile(join(gitDir, 'index'));
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(review.receipt).not.toBeNull();
    expect(review.paths.find((entry) => entry.path === path)?.staged).not.toBeNull();
    const result = await RecoveryJournal.resolveReviewed({
      receipt: review.receipt!,
      reviewDirectory,
    });
    expect(await fs.readFile(join(gitDir, 'index'))).toEqual(before);
    expect(result.outcome.staged).not.toBe('');
    expect(result.outcome.commits).toEqual([]);
    expect(result.outcome.push).toBe('not-attempted');
  }, 30_000);

  it('proposes a user-only permission repair and never auto-chmods an unsupported checkout output', async () => {
    const journal = await adopted();
    await retireFixtureOwner(journal);
    await fs.chmod(join(root, path), 0o664);
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(review.receipt).toBeNull();
    expect((await fs.stat(join(root, path))).mode & 0o7777).toBe(0o664);
    const operation = review.operations.find((operation) => operation.argv[0] === 'chmod')!;
    expect(operation.argv[1]).toBe('0644');
    execFileSync(operation.argv[0], operation.argv.slice(1), { env: process.env });
    const repaired = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(repaired.receipt).not.toBeNull();
    await RecoveryJournal.resolveReviewed({ receipt: repaired.receipt!, reviewDirectory });
    expect(await fs.readFile(join(root, path))).toEqual(incoming);
  }, 30_000);

  it('requires a user-authored forward repair of an incompatible actual local commit, never replays or pushes it', async () => {
    const journal = await adopted();
    const generated = bytes('# Incoming\n\nGenerated retained prose\n');
    await journal.applyOutput(path, incoming, generated, async () => {});
    await journal.beginEffect('commit', { paths: [path] });
    await fs.writeFile(join(root, path), '# Lost\n');
    git(root, 'add', '--', path);
    git(root, 'commit', '-qm', 'fixture incompatible partial commit');
    const bad = git(root, 'rev-parse', 'HEAD').trim();
    await fs.writeFile(join(root, path), generated);
    await retireFixtureOwner(journal);
    const rejected = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(rejected.receipt).toBeNull();
    expect(rejected.blockers.join('\n')).toContain('committed object');
    git(root, 'add', '--', path);
    git(root, 'commit', '-qm', 'fixture user forward repair');
    const fixed = git(root, 'rev-parse', 'HEAD').trim();
    const remoteBefore = git(join(base, 'remote.git'), 'rev-parse', 'main');
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(review.receipt).not.toBeNull();
    const result = await RecoveryJournal.resolveReviewed({
      receipt: review.receipt!,
      reviewDirectory,
    });
    expect(result.outcome.commits).toEqual([bad, fixed]);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(fixed);
    expect(git(join(base, 'remote.git'), 'rev-parse', 'main')).toBe(remoteBefore);
    expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
  }, 30_000);

  it('records an already effected pending push as uncertain and never replays it during manual closure', async () => {
    const journal = await adopted();
    const generated = bytes('# Incoming\n\nCommitted retained prose\n');
    await journal.applyOutput(path, incoming, generated, async () => {});
    const commit = await journal.beginEffect('commit', { paths: [path] });
    git(root, 'add', '--', path);
    git(root, 'commit', '-qm', 'fixture completed output');
    state = await readRecoveryGitState(root, {
      maxBytes: RECOVERY_LIMITS.journalBytes,
      maxEntries: RECOVERY_LIMITS.entries,
    });
    await journal.completeEffect(commit, state);
    await journal.beginEffect('push', { remote: 'origin' });
    git(root, 'push', '-q');
    await retireFixtureOwner(journal);
    const remoteHead = git(join(base, 'remote.git'), 'rev-parse', 'main');
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(review.receipt?.push).toBe('uncertain');
    const result = await RecoveryJournal.resolveReviewed({
      receipt: review.receipt!,
      reviewDirectory,
    });
    expect(result.outcome.push).toBe('uncertain');
    expect(git(join(base, 'remote.git'), 'rev-parse', 'main')).toBe(remoteHead);
    expect(
      (await readRecoveryManifest(result.directory)).intents.find(
        (intent) => intent.kind === 'push',
      )?.status,
    ).toBe('reconciled');
  }, 30_000);

  it('manually verifies an archive already moved before a failed parent fsync without renaming or replaying it again', async () => {
    const journal = await adopted();
    armed = 'archive.source-parent.fsync:before';
    await expect(
      journal.finish(
        {
          head: state.head,
          commits: [],
          staged: '',
          push: 'not-attempted',
          protectedVerified: true,
        },
        async () => {},
      ),
    ).rejects.toThrow('manual injected');
    await retireFixtureOwner(journal);
    const location = journal.directory;
    const review = await inspectManualRecovery({ directory: location, reviewDirectory });
    expect(review.receipt).not.toBeNull();
    const edges: string[] = [];
    const result = await RecoveryJournal.resolveReviewed({
      receipt: review.receipt!,
      reviewDirectory,
      hooks: {
        boundary: async (edge) => {
          edges.push(edge);
        },
      },
    });
    expect(result.directory).toBe(location);
    expect(edges).not.toContain('archive.rename:before');
    expect(edges).toContain('archive.source-parent.fsync:after');
    expect(edges).toContain('archive.destination-parent.fsync:after');
    expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
  }, 30_000);

  it('measures real retained byte exhaustion and refuses administrative publication before taking a token', async () => {
    const journal = await prepared();
    await retireFixtureOwner(journal);
    const record = await readRecoveryManifest(journal.directory);
    const path = join(journal.directory, 'data/retained-large.metadata');
    const file = await fs.open(path, 'wx', 0o600);
    try {
      await file.truncate(
        RECOVERY_LIMITS.journalBytes -
          RECOVERY_LIMITS.emergencyBytes -
          record.resources.usedBytes -
          1,
      );
    } finally {
      await file.close();
    }
    const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
    expect(review.receipt).not.toBeNull();
    const before = await fs.readFile(join(journal.directory, 'manifest.json'));
    await expect(
      RecoveryJournal.resolveReviewed({ receipt: review.receipt!, reviewDirectory }),
    ).rejects.toThrow('headroom');
    expect(await fs.readFile(join(journal.directory, 'manifest.json'))).toEqual(before);
    expect(await readSyncLockToken(gitDir)).not.toBeNull();
    expect((await fs.stat(path)).size).toBeGreaterThan(RECOVERY_LIMITS.indexBytes);
  }, 30_000);

  it.each([
    'manual.before-claim',
    'manual.evidence.fsync:before',
    'manual.source-manifest.fsync:before',
    'manifest.manual-claim.rename:after',
    'manual.after-claim',
    'manifest.manual-resolved.rename:after',
    'archive.rename:after',
    'archive.destination-parent.fsync:before',
    'manifest.archived.published-parent.fsync:before',
  ])(
    'retains manual evidence and never falsely resolves after %s',
    async (edge) => {
      const journal = await prepared();
      await retireFixtureOwner(journal);
      const review = await inspectManualRecovery({ directory: journal.directory, reviewDirectory });
      let fired = false;
      await expect(
        RecoveryJournal.resolveReviewed({
          receipt: review.receipt!,
          reviewDirectory,
          hooks: {
            boundary: async (point) => {
              if (point === edge && !fired) {
                fired = true;
                throw Object.assign(new Error(`manual fault ${edge}`), { code: 'ENOSPC' });
              }
            },
          },
        }),
      ).rejects.toThrow(`manual fault ${edge}`);
      expect(fired).toBe(true);
      expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
      expect(await fs.readFile(join(root, path))).toEqual(local);
    },
    30_000,
  );
});

describe('inactive recovery raw protection foundations', () => {
  it('allows stale strict draft changes but compares all other raw spans including blanks and EOF', () => {
    expect(recoveryCandidateQualifies(bytes(`# Human\n\n${draft}\n`), bytes('# Human\n\n'))).toBe(
      true,
    );
    expect(recoveryCandidateQualifies(bytes(`# Human\n${draft}`), bytes('# Human'))).toBe(false);
    expect(recoveryCandidateQualifies(bytes(`# Human\r\n${draft}\r\n`), bytes('# Human\n'))).toBe(
      false,
    );
    expect(recoveryCandidateQualifies(bytes(`# Human\n${draft}\n`), bytes('# Human\n\n'))).toBe(
      false,
    );
  });

  it.each([
    `${draft} <!-- annotation -->`,
    '- [old](old.md) <!-- draft -->',
    '- [old](../old.md) — *Stale*. <!-- draft -->',
    '- [old](old.md) — *Human <!-- annotation -->*. <!-- draft -->',
    `~~~\n${draft}\n~~~`,
    `\`\`\`\n${draft}\n\`\`\``,
    // Loose-row ownership amendment: the counterexample row shape — a
    // NON-draft loose row is protected human content on the recovery side,
    // matching the generator's verbatim preservation.
    '- [loose](loose.md) — Loose row',
  ])('retains non-owned or fenced content byte-exactly: %s', (text) => {
    expect(recoveryProtectedSpans(bytes(text)).length).toBeGreaterThan(0);
    expect(recoveryCandidateQualifies(bytes(text), bytes(''))).toBe(false);
  });

  it.each([Buffer.from([0xff]), bytes('a\0b'), bytes('a\r\nb\n'), bytes('a\rb')])(
    'refuses unsupported encoding or mixed EOL',
    (value) => {
      expect(() => recoveryProtectedSpans(value)).toThrow();
    },
  );

  it('checks ordered independent duplicate-sensitive sequences without demanding extra copies', () => {
    const requirement = recoveryProtectedSpans(bytes('one\none\ntwo'));
    expect(() =>
      assertRecoveryRequirements(bytes('one\nextra\none\ntwo'), [requirement, requirement]),
    ).not.toThrow();
    expect(() => assertRecoveryRequirements(bytes('one\ntwo'), [requirement])).toThrow(
      'sequence lost',
    );
    expect(() => assertRecoveryRequirements(bytes('one\none\ntwo\n'), [requirement])).toThrow(
      'sequence lost',
    );
    expect(() => assertRecoveryRequirements(null, [requirement])).toThrow('vanished');
  });

  it('incoming output replacement retains M/A, not superseded local/H prose', () => {
    const record = prepareRecoveryProtection(
      'knowledge/index.md',
      'output',
      'modified',
      bytes('old\n'),
      bytes('old\n'),
      bytes('incoming\n'),
      true,
    );
    const adopted = adoptRecoveryProtection(record, bytes('incoming\n'));
    expect(() =>
      assertRecoveryRequirements(bytes('incoming\n'), adopted.requirements),
    ).not.toThrow();
    expect(() => adoptRecoveryProtection(record, bytes('hook changed\n'))).toThrow('pinned inert');
  });

  it('source-only conversion adopts actual A without demanding raw M TRANSFORM', () => {
    const record = prepareRecoveryProtection(
      'knowledge/2026-07-12-child/index.md',
      'source',
      'modified',
      bytes('old\n'),
      bytes('old\n'),
      bytes('TRANSFORM\n'),
    );
    const adopted = adoptRecoveryProtection(record, bytes('## Salientquartz\n'));
    expect(() =>
      assertRecoveryRequirements(bytes('## Salientquartz\n'), adopted.requirements),
    ).not.toThrow();
    expect(() => assertRecoveryRequirements(bytes('TRANSFORM\n'), adopted.requirements)).toThrow(
      'sequence lost',
    );
    expect(() => adoptRecoveryProtection(adopted, bytes('new baseline\n'))).toThrow(
      'already adopted',
    );
  });

  it('unchanged skipped paths retain local requirements plus new additions across continuation', () => {
    const record = prepareRecoveryProtection(
      'knowledge/2026-07-12-child/index.md',
      'source',
      'unchanged',
      bytes('local annotation\n'),
      bytes('old\n'),
      bytes('old\n'),
    );
    expect(() => adoptRecoveryProtection(record, bytes('old\n'))).toThrow('sequence lost');
    const adopted = adoptRecoveryProtection(record, bytes('local annotation\n'));
    const extended = extendRecoveryProtection(adopted, bytes('local annotation\nnew prose\n'));
    expect(extended.requirements.length).toBe(2);
    expect(() => extendRecoveryProtection(extended, bytes('local annotation\n'))).toThrow(
      'sequence lost',
    );
    expect(() => assertRecoveryRequirements(null, extended.requirements)).toThrow('vanished');
    expect(record.adopted).toBe(false);
  });

  it('refuses protected incoming deletions and candidate protected changes', () => {
    expect(() =>
      prepareRecoveryProtection(
        'knowledge/index.md',
        'output',
        'deleted',
        bytes('human\n'),
        bytes('human\n'),
        null,
      ),
    ).toThrow('deletion');
    expect(() =>
      prepareRecoveryProtection(
        'knowledge/index.md',
        'output',
        'modified',
        bytes('edited human\n'),
        bytes('old\n'),
        bytes('incoming\n'),
        true,
      ),
    ).toThrow('candidate');
    expect(() =>
      prepareRecoveryProtection('knowledge/index.md', 'output', 'added', null, null, null),
    ).toThrow('Missing pinned');
  });
});

describe('inactive strict recovery data/manifest/target protocol', () => {
  const path = 'knowledge/index.md';
  const local = bytes(`# Human\n\n${draft}\n`);
  const head = bytes('# Human\n\n');
  const incoming = bytes('# Incoming human\n\n');
  let root: string;
  let gitDir: string;
  let lock: SyncLock;
  let lease: RecoveryLease;
  let state: RecoveryGitState;
  let journal: RecoveryJournal | null;
  let armed: string | null;
  let injected = false;
  let events: string[];
  let hooks: RecoveryPersistenceHooks;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'condash-strict-recovery-'));
    gitDir = join(root, '.git');
    await fs.mkdir(gitDir);
    await fs.mkdir(join(root, 'knowledge'));
    await fs.writeFile(join(root, path), local, { mode: 0o644 });
    await fs.utimes(join(root, path), new Date(0), new Date(0));
    const acquired = await acquireSyncLock(gitDir);
    if (!acquired.acquired) throw new Error('Fixture ordinary lock unavailable');
    lock = acquired.lock;
    lease = await promoteSyncLock(lock);
    state = {
      root,
      gitDir,
      head: 'a'.repeat(40),
      upstreamOid: 'b'.repeat(40),
      branch: 'refs/heads/main',
      upstream: 'refs/remotes/origin/main',
      remote: 'origin',
      mergeRef: 'refs/heads/main',
      pushRef: 'refs/remotes/origin/main',
      pushRemote: 'origin',
      pushMergeRef: 'refs/heads/main',
      remoteUrls: ['fixture-local'],
      pushUrls: ['fixture-local'],
      config: [],
      entries: [],
      staged: '',
    };
    journal = null;
    armed = null;
    injected = false;
    events = [];
    hooks = {
      verifyGit: async () => {}, // These fault tests isolate persistence; the runtime fixture uses actual Git proofs.
      boundary: async (edge) => {
        events.push(edge);
        if (edge === armed && !injected) {
          injected = true;
          throw Object.assign(new Error(`injected ${edge}`), { code: 'EIO' });
        }
      },
    };
  });
  afterEach(async () => {
    if (journal) await journal.releaseForManualReconciliation().catch(() => {});
    await lease
      .assertOwned()
      .then(() => lock.release())
      .catch(() => {});
    await lease.close();
    // Retain fixture evidence beneath the test-owned TMPDIR, including fault-created partial directories.
  });

  async function create(budget?: RecoveryBudget): Promise<RecoveryJournal> {
    journal = await RecoveryJournal.create({
      root,
      gitDir,
      state,
      lock,
      lease,
      invocation: {
        kind: 'syncRun',
        dryRun: false,
        push: true,
        integration: 'ff-only',
        quietPeriodSeconds: 90,
        cutoffMs: Date.now() - 90_000,
      },
      hooks,
      budget,
    });
    return journal;
  }
  async function prepare(): Promise<RecoveryJournal> {
    const owner = await create();
    await owner.addPath({
      path,
      role: 'output',
      incoming: 'modified',
      head,
      incomingBytes: incoming,
      candidate: true,
      eligibleAtMs: 0,
    });
    await owner.prepare();
    return owner;
  }
  async function normalized(): Promise<RecoveryJournal> {
    const owner = await prepare();
    await owner.normalizeCandidate(path, async () => {});
    return owner;
  }
  async function adopted(): Promise<RecoveryJournal> {
    const owner = await normalized();
    const merge = await owner.beginEffect('merge', { target: state.upstreamOid });
    await fs.writeFile(join(root, path), incoming);
    state = { ...state, head: state.upstreamOid };
    await owner.completeEffect(merge, state);
    await owner.adoptActual();
    return owner;
  }

  it('durably relinquishes and exclusively claims the exact generation with retained and newly observed requirements', async () => {
    const owner = await adopted();
    const oldNonce = owner.snapshot().owner.nonce;
    await owner.defer();
    const deferred = await readRecoveryManifest(owner.directory);
    expect(deferred).toMatchObject({ phase: 'deferred', relinquished: true });
    await expect(fs.stat(lock.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.appendFile(join(root, path), 'new human requirement\n');
    journal = await RecoveryJournal.claim({
      root,
      gitDir,
      generation: deferred.generation,
      invocation: {
        kind: 'syncRun',
        dryRun: false,
        push: true,
        integration: 'ff-only',
        quietPeriodSeconds: 0,
      },
      hooks,
    });
    const claimed = await readRecoveryManifest(journal.directory);
    expect(claimed).toMatchObject({
      phase: 'generating',
      relinquished: false,
      generation: deferred.generation + 1,
    });
    expect(claimed.owner.nonce).not.toBe(oldNonce);
    expect(claimed.paths[0].protection.requirements).toContainEqual(
      recoveryProtectedSpans(bytes('# Incoming human\n\nnew human requirement\n')),
    );
    await expect(
      journal.applyOutput(
        path,
        bytes('# Incoming human\n\nnew human requirement\n'),
        incoming,
        async () => {},
      ),
    ).rejects.toThrow('sequence lost');
  }, 20_000);

  it.each([
    'journal-root.mkdir:after',
    'journal-root.self.fsync:before',
    'journal-root.parent.close:before',
    'journal-active.mkdir:after',
    'token.purpose.open:before',
    'token.purpose.truncate:after',
    'token.purpose.write:after',
    'token.purpose.fsync:before',
    'token.purpose.close:before',
    'token.purpose.readback:before',
    'token.purpose.parent.fsync:before',
    'token.purpose.parent.close:before',
    'manifest.prepare.rename:after',
  ])(
    'retains bootstrap evidence and generic cleanup cannot delete its token after %s',
    async (edge) => {
      armed = edge;
      const tokenIdentity = { dev: lock.token.dev, ino: lock.token.ino, nonce: lock.token.nonce };
      await expect(create()).rejects.toThrow(`injected ${edge}`);
      expect(injected).toBe(true);
      await expect(lock.release()).rejects.toThrow('generic release is forbidden');
      const stat = await fs.lstat(lock.path, { bigint: true });
      expect({ dev: String(stat.dev), ino: String(stat.ino) }).toEqual({
        dev: tokenIdentity.dev,
        ino: tokenIdentity.ino,
      });
      expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
      await expect(acquireSyncLock(gitDir)).rejects.toThrow('Unresolved index recovery');
      expect(await fs.readFile(join(root, path))).toEqual(local);
    },
    20_000,
  );

  it.each(['terminal', 'deferred'] as const)(
    'retains the %s witness when final readback or persistence and every emergency open fail',
    async (kind) => {
      const owner = await adopted();
      const original = await fs.readFile(lock.path);
      const label = kind === 'terminal' ? 'manifest.archived' : 'manifest.deferred';
      let fault = false;
      hooks.boundary = async (edge) => {
        if (edge === `${label}.readback:before`) {
          fault = true;
          throw new Error('final readback EIO');
        }
        if (edge === 'emergency-error.open:before') throw new Error('emergency ENOSPC');
      };
      const operation =
        kind === 'terminal'
          ? owner.finish(
              {
                head: state.head,
                commits: [],
                staged: '',
                push: 'not-attempted',
                protectedVerified: true,
              },
              async () => {},
            )
          : owner.defer();
      await expect(operation).rejects.toThrow('final readback EIO');
      expect(fault).toBe(true);
      await owner.releaseForManualReconciliation();
      expect(await fs.readFile(lock.path)).toEqual(original);
      const record = JSON.parse(await fs.readFile(join(owner.directory, 'manifest.json'), 'utf8'));
      expect(record.version).toBe(2);
      expect(record.releasePrerequisite.generation).toBe(record.generation);
      expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
      await expect(acquireSyncLock(gitDir)).rejects.toThrow('Unresolved index recovery');
      expect((await fs.readdir(owner.directory)).some((name) => name.startsWith('error-'))).toBe(
        false,
      );
    },
    20_000,
  );

  it.each([
    'token.release.unlink:after',
    'token.release.parent.fsync:before',
    'token.release.parent.close:before',
    'token.release.helper:before',
  ])(
    'reports cleanup uncertainty only, with no emergency publication after acknowledgment at %s',
    async (edge) => {
      const owner = await adopted();
      armed = edge;
      await owner.finish(
        {
          head: state.head,
          commits: [],
          staged: '',
          push: 'not-attempted',
          protectedVerified: true,
        },
        async () => {},
      );
      expect(injected).toBe(true);
      expect(owner.cleanupError).toContain(`injected ${edge}`);
      expect(await readSyncLockToken(gitDir)).toBeNull();
      expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
      expect(events).not.toContain('emergency-error.open:before');
      await owner.recordFailure(new Error('must not mutate finalized evidence'));
      expect((await fs.readdir(owner.directory)).some((name) => name.startsWith('error-'))).toBe(
        false,
      );
      const ordinary = await acquireSyncLock(gitDir);
      expect(ordinary.acquired).toBe(true);
      expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
      if (ordinary.acquired) await ordinary.lock.release();
    },
    20_000,
  );

  it('does not infer acknowledgment from a missing token before the authorized removal attempt', async () => {
    const owner = await adopted();
    hooks.boundary = async (edge) => {
      if (edge === 'token.release.unlink:before') await fs.unlink(lock.path);
    };
    await expect(
      owner.finish(
        {
          head: state.head,
          commits: [],
          staged: '',
          push: 'not-attempted',
          protectedVerified: true,
        },
        async () => {},
      ),
    ).rejects.toThrow('ownership lost');
    expect(owner.cleanupError).toBeNull();
  }, 20_000);

  it.each(['generation', 'transaction', 'owner', 'location', 'protocol', 'kind'])(
    'refuses a final release descriptor with changed %s',
    async (field) => {
      const owner = await adopted();
      await owner.defer();
      const record = await readRecoveryManifest(owner.directory);
      const changed = JSON.parse(JSON.stringify(record));
      changed.releasePrerequisite[field] = field === 'generation' ? record.generation - 1 : 'wrong';
      expect(() => validateRecoveryManifest(changed)).toThrow('release prerequisite');
    },
    20_000,
  );

  it('retains a durable foreign claimant token before its owner manifest and refuses a second automatic claim', async () => {
    const owner = await adopted();
    await owner.defer();
    const deferred = await readRecoveryManifest(owner.directory);
    let created: SyncLockToken | null = null;
    await expect(
      RecoveryJournal.claim({
        root,
        gitDir,
        generation: deferred.generation,
        invocation: {
          kind: 'syncRun',
          dryRun: false,
          push: true,
          integration: 'ff-only',
          quietPeriodSeconds: 0,
        },
        hooks: {
          verifyGit: async () => {},
          boundary: async (edge) => {
            if (edge === 'claim.after-token') {
              created = await readSyncLockToken(gitDir);
              throw new Error('claim stopped before owner publication');
            }
          },
        },
      }),
    ).rejects.toThrow('claim stopped');
    expect(created).not.toBeNull();
    expect((created as SyncLockToken | null)?.nonce).not.toBe(deferred.owner.nonce);
    expect(await fs.readFile(join(owner.directory, 'manifest.json'), 'utf8')).toBe(
      JSON.stringify(deferred) + '\n',
    );
    await expect(
      RecoveryJournal.claim({
        root,
        gitDir,
        generation: deferred.generation,
        invocation: {
          kind: 'syncRun',
          dryRun: false,
          push: true,
          integration: 'ff-only',
          quietPeriodSeconds: 0,
        },
        hooks: { verifyGit: async () => {} },
      }),
    ).rejects.toThrow('absent publication token');
    expect(await readSyncLockToken(gitDir)).toEqual(created);
  }, 20_000);

  it.each(['generation', 'integration', 'invocation', 'head', 'requirements'])(
    'refuses deferred %s drift without claiming or rewriting the previous record',
    async (drift) => {
      const owner = await adopted();
      await owner.defer();
      const deferred = await readRecoveryManifest(owner.directory);
      const before = await fs.readFile(join(owner.directory, 'manifest.json'));
      if (drift === 'requirements') await fs.writeFile(join(root, path), 'lost\n');
      const claimHooks =
        drift === 'head'
          ? {
              ...hooks,
              verifyGit: async () => {
                throw new Error('fixture HEAD drift');
              },
            }
          : hooks;
      await expect(
        RecoveryJournal.claim({
          root,
          gitDir,
          generation: deferred.generation + (drift === 'generation' ? 1 : 0),
          invocation: {
            kind: drift === 'invocation' ? ('syncCommit' as 'syncRun') : 'syncRun',
            dryRun: false,
            push: true,
            integration: drift === 'integration' ? 'safe-merge' : 'ff-only',
            quietPeriodSeconds: 0,
          },
          hooks: claimHooks,
        }),
      ).rejects.toThrow();
      expect(await fs.readFile(join(owner.directory, 'manifest.json'))).toEqual(before);
      await expect(fs.stat(lock.path)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    20_000,
  );

  it('archives only after both move parents are fsynced, then ordinary acquisition can proceed', async () => {
    const owner = await adopted();
    await owner.finish(
      { head: state.head, commits: [], staged: '', push: 'not-attempted', protectedVerified: true },
      async () => {},
    );
    const terminal = await readRecoveryManifest(owner.directory);
    expect(terminal.phase).toBe('archived');
    expect(events.indexOf('archive.rename:after')).toBeLessThan(
      events.indexOf('archive.source-parent.fsync:before'),
    );
    expect(events.indexOf('archive.source-parent.fsync:after')).toBeLessThan(
      events.indexOf('archive.destination-parent.fsync:before'),
    );
    expect(events.indexOf('archive.destination-parent.fsync:after')).toBeLessThan(
      events.indexOf('manifest.archived.open:before'),
    );
    expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
    expect(
      (await inspectRecoveryEvidence(gitDir, { maxBytes: terminal.resources.usedBytes - 1 }))
        .length,
    ).toBeGreaterThan(0);
    expect((await inspectRecoveryEvidence(gitDir, { maxEntries: 1 })).length).toBeGreaterThan(0);
    const ordinary = await acquireSyncLock(gitDir);
    expect(ordinary.acquired).toBe(true);
    if (ordinary.acquired) await ordinary.lock.release();
  }, 20_000);

  it('retains the structured NUL-delimited staged observation without treating it as protected text', async () => {
    const owner = await adopted();
    const intent = await owner.beginEffect('stage', { paths: [path] });
    const raw = `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0${path}\0`;
    await owner.completeEffect(intent, { ...state, staged: raw });
    expect((await readRecoveryManifest(owner.directory)).expected.staged).toBe(raw);
  }, 20_000);

  it('captures private attribute artifacts and their bounded metadata before manifest references', async () => {
    const owner = await prepare();
    const proof = await owner.captureAttributeProof(4096, async (directory) => {
      const privateDirectory = join(directory, 'attributes-fixture');
      await fs.mkdir(privateDirectory, { mode: 0o700 });
      const index = join(privateDirectory, 'index');
      await fs.writeFile(index, Buffer.from([0, 255, 1]), { mode: 0o600 });
      return {
        head: state.head,
        incoming: state.upstreamOid,
        paths: [],
        config: [],
        dependencies: [],
        attributes: [],
        privateIndexes: [index],
        indexAttributes: '',
        environment: {},
      };
    });
    expect(proof.privateIndexes).toHaveLength(1);
    const record = await readRecoveryManifest(owner.directory);
    expect(record.attributeProofs).toHaveLength(1);
    expect(
      record.data.find((reference) => reference.file.endsWith('attributes-fixture/index'))?.bytes,
    ).toBe(3);
    expect(events.indexOf('attributes.file.fsync:after')).toBeLessThan(
      events.indexOf('manifest.attributes.rename:before'),
    );
  }, 20_000);

  it('durably extends dynamically enlisted source requirements before input use and output promotion', async () => {
    const owner = await adopted();
    const dynamic = 'knowledge/late/index.md';
    await fs.mkdir(join(root, 'knowledge/late'));
    await fs.writeFile(join(root, dynamic), '# Late\n', { mode: 0o644 });
    await owner.addPath({
      path: dynamic,
      role: 'source',
      incoming: 'unchanged',
      head: null,
      incomingBytes: null,
      eligibleAtMs: 0,
    });
    await fs.appendFile(join(root, dynamic), 'new protected span\n');
    await owner.validateInput({ path: join(root, dynamic), kind: 'source' });
    const record = (await readRecoveryManifest(owner.directory)).paths.find(
      (record) => record.protection.path === dynamic,
    )!;
    expect(record.evidence.A).toBeDefined();
    expect(record.evidence.L).toBeUndefined();
    expect(record.protection.requirements).toContainEqual(
      recoveryProtectedSpans(bytes('# Late\nnew protected span\n')),
    );
    let proofs = 0;
    await owner.promoteOutput(dynamic, async () => {
      proofs++;
    });
    expect(proofs).toBe(1);
    await expect(
      owner.applyOutput(
        dynamic,
        bytes('# Late\nnew protected span\n'),
        bytes('# Late\n'),
        async () => {},
      ),
    ).rejects.toThrow('sequence lost');
  }, 20_000);

  it('does not promote a converted source baseline into an incoming inert output', async () => {
    const owner = await adopted();
    const dynamic = 'knowledge/converted/index.md';
    await fs.mkdir(join(root, 'knowledge/converted'));
    await fs.writeFile(join(root, dynamic), '# Converted actual\n', { mode: 0o644 });
    await owner.addPath({
      path: dynamic,
      role: 'source',
      incoming: 'modified',
      head: bytes('# Original\n'),
      incomingBytes: bytes('TRANSFORM\n'),
      eligibleAtMs: 0,
    });
    let proved = false;
    await expect(
      owner.promoteOutput(dynamic, async () => {
        proved = true;
      }),
    ).rejects.toThrow('Converted source');
    expect(proved).toBe(false);
    expect(await fs.readFile(join(root, dynamic), 'utf8')).toBe('# Converted actual\n');
  }, 20_000);

  it('can resolve unchanged before any merge and preserves existing terminal archives for the next transaction', async () => {
    const owner = await normalized();
    await owner.rollbackCandidate(path, async () => {});
    await owner.resolveUnchanged(async () => {});
    expect((await readRecoveryManifest(owner.directory)).resolvedBeforeMerge).toBe(true);
    expect(await inspectRecoveryEvidence(gitDir)).toEqual([]);
    const acquired = await acquireSyncLock(gitDir);
    if (!acquired.acquired) throw new Error('Fixture next owner unavailable');
    lock = acquired.lock;
    lease = await promoteSyncLock(lock);
    journal = await RecoveryJournal.create({
      root,
      gitDir,
      state,
      lock,
      lease,
      invocation: {
        kind: 'syncRun',
        dryRun: false,
        push: true,
        integration: 'ff-only',
        quietPeriodSeconds: 90,
        cutoffMs: Date.now() - 90_000,
      },
      hooks,
    });
    expect(journal.snapshot().phase).toBe('preparing');
    expect((await fs.readdir(join(gitDir, 'condash-index-recovery/resolved'))).length).toBe(1);
  }, 20_000);

  it.each([
    'manifest.deferred.rename:after',
    'manifest.deferred.published-parent.fsync:before',
    'deferred.before-release',
    'manifest.complete.rename:after',
    'manifest.complete.published-parent.fsync:before',
    'manifest.archive-pending.rename:after',
    'manifest.archive-pending.published-parent.fsync:before',
    'archive-root.mkdir:after',
    'archive-root.self.fsync:before',
    'archive-root.parent.fsync:before',
    'archive.rename:before',
    'archive.rename:after',
    'archive.source-parent.fsync:before',
    'archive.destination-parent.fsync:before',
    'manifest.archived.rename:after',
    'manifest.archived.published-parent.fsync:before',
  ])(
    'does not report or discover false resolution on continuation/archive fault at %s',
    async (edge) => {
      const owner = await adopted();
      armed = edge;
      if (edge === 'deferred.before-release') {
        const original = hooks.boundary!;
        hooks.boundary = async (point, path) => original(point, path);
      }
      const operation =
        edge.startsWith('manifest.deferred') || edge.startsWith('deferred.')
          ? owner.defer()
          : owner.finish(
              {
                head: state.head,
                commits: [],
                staged: '',
                push: 'not-attempted',
                protectedVerified: true,
              },
              async () => {},
            );
      await expect(operation).rejects.toThrow(`injected ${edge}`);
      expect(injected).toBe(true);
      expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
      await expect(owner.applyMarker('knowledge/.index-dirty', null, bytes(''))).rejects.toThrow(
        'halted',
      );
      await expect(acquireSyncLock(gitDir)).rejects.toThrow('Unresolved index recovery');
    },
    20_000,
  );

  it('never clobbers an observed existing archive destination', async () => {
    const owner = await adopted();
    hooks.boundary = async (edge, destination) => {
      if (edge === 'archive.rename:before') {
        await fs.mkdir(destination, { mode: 0o700 });
        await fs.writeFile(join(destination, 'foreign'), 'retain');
      }
    };
    await expect(
      owner.finish(
        {
          head: state.head,
          commits: [],
          staged: '',
          push: 'not-attempted',
          protectedVerified: true,
        },
        async () => {},
      ),
    ).rejects.toThrow('already exists');
    const record = owner.snapshot();
    expect(
      await fs.readFile(
        join(gitDir, 'condash-index-recovery/resolved', record.archiveName!, 'foreign'),
        'utf8',
      ),
    ).toBe('retain');
    expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
  }, 20_000);

  it('persists private data before references and strict intents before the actual target effect', async () => {
    const owner = await normalized();
    const record = await readRecoveryManifest(owner.directory);
    expect(record.phase).toBe('normalizing');
    expect(record.paths[0].evidence.B).toEqual(record.paths[0].evidence.H);
    expect(record.intents).toHaveLength(1);
    expect(record.intents[0]).toMatchObject({ kind: 'candidate', status: 'complete', path });
    expect(await fs.readFile(join(root, path))).toEqual(head);
    expect(events.indexOf('manifest.candidate-intent.published-parent.fsync:after')).toBeLessThan(
      events.indexOf('target.rename:before'),
    );
    expect(events.indexOf('target.fsync:after')).toBeLessThan(
      events.indexOf('target.parent.fsync:before'),
    );
    expect(events.indexOf('target.parent.fsync:after')).toBeLessThan(
      events.indexOf('manifest.candidate-complete.open:before'),
    );
    for (const reference of record.data)
      expect((await fs.stat(join(owner.directory, reference.file))).mode & 0o7777).toBe(0o600);
    for (const directory of [
      join(gitDir, 'condash-index-recovery'),
      owner.directory,
      join(owner.directory, 'data'),
    ])
      expect((await fs.stat(directory)).mode & 0o7777).toBe(0o700);
    expect((await fs.stat(join(root, path))).mode & 0o7777).toBe(0o644);
    expect(record.resources.usedBytes).toBe(
      (await fs.stat(join(owner.directory, 'manifest.json'))).size +
        record.data.reduce((sum, reference) => sum + reference.bytes, 0),
    );
    expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
  }, 20_000);

  it('retains its token after helper death and never reacquires cleanup deletion authority', async () => {
    const owner = await prepare();
    process.kill(lease.helperPid, 'SIGKILL');
    await expect(owner.normalizeCandidate(path, async () => {})).rejects.toThrow(/lease|helper/);
    await owner.releaseForManualReconciliation();
    expect(await readSyncLockToken(gitDir)).toEqual(lock.token);
    expect(await fs.readFile(join(root, path))).toEqual(local);
    await expect(owner.normalizeCandidate(path, async () => {})).rejects.toThrow('halted');
    expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
  }, 20_000);

  it('restores only exact owned pre-merge B with saved mode and a representable saved mtime', async () => {
    const owner = await normalized();
    await owner.rollbackCandidate(path, async () => {});
    expect(await fs.readFile(join(root, path))).toEqual(local);
    expect((await fs.stat(join(root, path), { bigint: true })).mtimeNs).toBe(0n);
    const record = await readRecoveryManifest(owner.directory);
    expect(record.intents[1]).toMatchObject({ kind: 'rollback', status: 'complete' });
    expect(record.paths[0].current.identity!.ctimeNs).not.toBe(
      record.paths[0].original.identity!.ctimeNs,
    );
  }, 20_000);

  it.each(['before', 'mismatch'])(
    'retains honest partial rollback effects on a saved-time %s failure',
    async (failure) => {
      const owner = await normalized();
      hooks.boundary = async (edge) => {
        if (edge === 'target.utimes:before' && failure === 'before')
          throw Object.assign(new Error('saved time fault'), { code: 'EIO' });
        if (edge === 'target.utimes:after' && failure === 'mismatch')
          await fs.utimes(join(root, path), new Date(10), new Date(10));
      };
      await expect(owner.rollbackCandidate(path, async () => {})).rejects.toThrow(
        failure === 'before' ? 'saved time fault' : 'mtime mismatch',
      );
      expect(await fs.readFile(join(root, path))).toEqual(local);
      const raw = JSON.parse(await fs.readFile(join(owner.directory, 'manifest.json'), 'utf8'));
      expect(raw.intents[1]).toMatchObject({ kind: 'rollback', status: 'pending' });
      await expect(owner.prepare()).rejects.toThrow('halted');
    },
    20_000,
  );

  it('enforces the real shared quota counter at a completion publication after an actual target rename', async () => {
    const budget = new RecoveryBudget();
    const owner = await create(budget);
    await owner.addPath({
      path,
      role: 'output',
      incoming: 'modified',
      head,
      incomingBytes: incoming,
      candidate: true,
      eligibleAtMs: 0,
    });
    await owner.prepare();
    hooks.boundary = async (edge) => {
      if (edge !== 'target.rename:after') return;
      const reserved = budget.snapshot().reservedBytes;
      budget.consume(reserved);
      const remaining =
        RECOVERY_LIMITS.journalBytes - RECOVERY_LIMITS.emergencyBytes - budget.snapshot().usedBytes;
      budget.reserve(remaining);
      budget.consume(remaining);
    };
    await expect(owner.normalizeCandidate(path, async () => {})).rejects.toThrow(
      /reservation limit|resources exceed limits/,
    );
    expect(budget.snapshot().usedBytes).toBe(
      RECOVERY_LIMITS.journalBytes - RECOVERY_LIMITS.emergencyBytes,
    );
    expect(await fs.readFile(join(root, path))).toEqual(head);
    const raw = JSON.parse(await fs.readFile(join(owner.directory, 'manifest.json'), 'utf8'));
    expect(raw.intents[0].status).toBe('pending');
    await expect(owner.prepare()).rejects.toThrow('halted');
  }, 20_000);

  it('refuses fresh generated evidence at the actual quota boundary after completed normalization and checkout', async () => {
    const budget = new RecoveryBudget();
    const owner = await create(budget);
    await owner.addPath({
      path,
      role: 'output',
      incoming: 'modified',
      head,
      incomingBytes: incoming,
      candidate: true,
      eligibleAtMs: 0,
    });
    await owner.prepare();
    await owner.normalizeCandidate(path, async () => {});
    const merge = await owner.beginEffect('merge', { target: state.upstreamOid });
    await fs.writeFile(join(root, path), incoming);
    await owner.completeEffect(merge, { ...state, head: state.upstreamOid });
    await owner.adoptActual();
    const durable = await fs.readFile(join(owner.directory, 'manifest.json'));
    const retained = await readRecoveryManifest(owner.directory);
    budget.consume(budget.snapshot().reservedBytes);
    const available =
      RECOVERY_LIMITS.journalBytes - RECOVERY_LIMITS.emergencyBytes - budget.snapshot().usedBytes;
    budget.reserve(available);
    budget.consume(available);
    const generated = Buffer.concat([incoming, bytes('\nFresh protected output\n')]);
    await expect(owner.applyOutput(path, incoming, generated, async () => {})).rejects.toThrow(
      'reservation limit',
    );
    expect(await fs.readFile(join(root, path))).toEqual(incoming);
    expect(await fs.readFile(join(owner.directory, 'manifest.json'))).toEqual(durable);
    expect(retained.intents.map((intent) => intent.status)).toEqual(['complete', 'complete']);
    for (const reference of retained.data)
      expect(
        createHash('sha256')
          .update(await fs.readFile(join(owner.directory, reference.file)))
          .digest('hex'),
      ).toBe(reference.sha256);
    await expect(owner.applyOutput(path, incoming, generated, async () => {})).rejects.toThrow(
      'halted',
    );
  }, 20_000);

  it('never restores after external same-content stat drift or after a merge intent', async () => {
    const owner = await normalized();
    await fs.utimes(join(root, path), new Date(1), new Date(1));
    await expect(owner.rollbackCandidate(path, async () => {})).rejects.toThrow('Owned B changed');
    expect(await fs.readFile(join(root, path))).toEqual(head);
    await expect(owner.normalizeCandidate(path, async () => {})).rejects.toThrow('halted');
    await expect(readRecoveryManifest(owner.directory)).rejects.toThrow('Unresolved or unexpected');
  }, 20_000);

  it('adopts actual incoming protection and guards changed and unchanged proposed outputs', async () => {
    const owner = await normalized();
    const merge = await owner.beginEffect('merge', { target: state.upstreamOid });
    await fs.writeFile(join(root, path), incoming);
    state = { ...state, head: state.upstreamOid };
    await owner.completeEffect(merge, state);
    await owner.adoptActual();
    const proposed = bytes('# Incoming human\n\nGenerated tail\n');
    let proofs = 0;
    await owner.applyOutput(path, incoming, proposed, async () => {
      proofs++;
    });
    await owner.applyOutput(path, proposed, proposed, async () => {
      proofs++;
    });
    expect(proofs).toBeGreaterThanOrEqual(4);
    expect(await fs.readFile(join(root, path))).toEqual(proposed);
    expect(
      (await readRecoveryManifest(owner.directory)).paths[0].protection.requirements,
    ).toContainEqual(recoveryProtectedSpans(incoming));
    await expect(
      owner.applyOutput(path, proposed, bytes('lost\n'), async () => {}),
    ).rejects.toThrow('sequence lost');
    expect(await fs.readFile(join(root, path))).toEqual(proposed);
    await expect(owner.rollbackCandidate(path, async () => {})).rejects.toThrow('halted');
  }, 20_000);

  it('records opaque-hook warming even for exact M bytes and does not warm on its own generation timestamps', async () => {
    const owner = await normalized();
    const merge = await owner.beginEffect('merge', { target: state.upstreamOid });
    await fs.writeFile(join(root, path), incoming);
    state = { ...state, head: state.upstreamOid };
    await owner.completeEffect(merge, state);
    await owner.adoptActual({ observedAtMs: 1234, opaqueHook: true });
    expect(owner.snapshot().paths[0].eligibleAtMs).toBe(1234);
    const proposed = bytes('# Incoming human\n\nOwn generated span\n');
    await owner.applyOutput(path, incoming, proposed, async () => {});
    expect(owner.snapshot().paths[0].eligibleAtMs).toBe(1234);
    await fs.utimes(join(root, path), new Date(10), new Date(10));
    await owner.validateInput({ path: join(root, path), kind: 'output' });
    expect(owner.snapshot().paths[0].eligibleAtMs).toBeGreaterThan(1234);
  }, 20_000);

  it('publishes marker unlink intent and parent durability before completion', async () => {
    const owner = await prepare();
    const marker = 'knowledge/.index-dirty';
    await fs.writeFile(join(root, marker), 'retain\n', { mode: 0o644 });
    await owner.applyMarker(marker, bytes('retain\n'), null);
    await expect(fs.stat(join(root, marker))).rejects.toMatchObject({ code: 'ENOENT' });
    const record = await readRecoveryManifest(owner.directory);
    expect(record.intents[0]).toMatchObject({ kind: 'marker', status: 'complete', proposed: null });
    expect(events.indexOf('target.unlink:before')).toBeGreaterThan(
      events.indexOf('manifest.marker-intent.published-parent.fsync:after'),
    );
  }, 20_000);

  it('handles genuine short writes without truncation and refuses zero-write progress', async () => {
    let writes = 0;
    hooks.write = async (handle, bytes, offset) => {
      writes++;
      return (
        await handle.write(
          bytes,
          offset,
          Math.max(1, Math.floor((bytes.length - offset) / 2)),
          offset,
        )
      ).bytesWritten;
    };
    const owner = await prepare();
    expect(writes).toBeGreaterThan(4);
    expect((await readRecoveryManifest(owner.directory)).paths).toHaveLength(1);
    hooks.write = async () => 0;
    await expect(owner.normalizeCandidate(path, async () => {})).rejects.toThrow('short write');
    expect(await fs.readFile(join(root, path))).toEqual(local);
  }, 20_000);

  it('treats actual close errors and ENOSPC as unresolved rather than successful publication', async () => {
    const owner = await prepare();
    let closingTarget = false;
    hooks.boundary = async (edge) => {
      if (edge === 'target.temporary.close:before') closingTarget = true;
    };
    hooks.close = async (handle) => {
      await handle.close();
      if (closingTarget) {
        closingTarget = false;
        throw Object.assign(new Error('injected close failure'), { code: 'ENOSPC' });
      }
    };
    await expect(owner.normalizeCandidate(path, async () => {})).rejects.toThrow('close failure');
    expect(await fs.readFile(join(root, path))).toEqual(local);
    const raw = JSON.parse(await fs.readFile(join(owner.directory, 'manifest.json'), 'utf8'));
    expect(raw.intents[0].status).toBe('pending');
    await expect(owner.applyMarker('knowledge/.index-dirty', null, bytes(''))).rejects.toThrow(
      'halted',
    );
  }, 20_000);

  it('retains the prior durable intent even if emergency error publication also fails', async () => {
    const owner = await prepare();
    hooks.boundary = async (edge) => {
      if (edge === 'target.fsync:before' || edge === 'emergency-error.open:before')
        throw Object.assign(new Error(`double failure ${edge}`), { code: 'ENOSPC' });
    };
    await expect(owner.normalizeCandidate(path, async () => {})).rejects.toThrow(
      'double failure target.fsync',
    );
    const record = await readRecoveryManifest(owner.directory);
    expect(record.intents[0]).toMatchObject({ kind: 'candidate', status: 'pending' });
    expect(await fs.readFile(join(root, path))).toEqual(head);
    await expect(owner.prepare()).rejects.toThrow('halted');
    await expect(acquireSyncLock(gitDir)).rejects.toThrow('Unresolved index recovery');
  }, 20_000);

  it.each([
    'journal-root.mkdir:after',
    'journal-root.self.fsync:before',
    'journal-root.parent.fsync:before',
    'journal-active.mkdir:after',
    'journal-active.self.fsync:before',
    'journal-active.parent.fsync:before',
    'journal-data.mkdir:after',
    'journal-data.self.fsync:before',
    'journal-data.parent.fsync:before',
    'manifest.prepare.open:after',
    'manifest.prepare.write:before',
    'manifest.prepare.fsync:before',
    'manifest.prepare.close:before',
    'manifest.prepare.parent.fsync:before',
    'manifest.prepare.verified:before',
    'manifest.prepare.rename:before',
    'manifest.prepare.rename:after',
    'manifest.prepare.published-parent.fsync:before',
    'data.open:after',
    'data.write:before',
    'data.fsync:before',
    'data.close:before',
    'data.parent.fsync:before',
    'data.verified:before',
    'data.readback:before',
    'manifest.prepared.rename:after',
    'manifest.prepared.published-parent.fsync:before',
    'manifest.candidate-intent.rename:after',
    'manifest.candidate-intent.published-parent.fsync:before',
    'target.temporary.open:after',
    'target.temporary.chmod:before',
    'target.temporary.write:before',
    'target.temporary.fsync:before',
    'target.temporary.close:before',
    'target.temporary.parent.fsync:before',
    'target.temporary.verified:before',
    'target.rename:before',
    'target.rename:after',
    'target.open:after',
    'target.fsync:before',
    'target.close:before',
    'target.parent.fsync:before',
    'target.readback:before',
    'manifest.candidate-complete.open:before',
    'manifest.candidate-complete.rename:after',
    'manifest.candidate-complete.published-parent.fsync:before',
  ])(
    'retains unresolved evidence on ordered persistence failure at %s',
    async (edge) => {
      armed = edge;
      await expect(normalized()).rejects.toThrow(`injected ${edge}`);
      expect(injected).toBe(true);
      expect((await inspectRecoveryEvidence(gitDir)).length).toBeGreaterThan(0);
      const actual = await fs.readFile(join(root, path));
      expect(actual.equals(local) || actual.equals(head)).toBe(true);
      if (journal) {
        await expect(journal.prepare()).rejects.toThrow('halted');
        const manifestPath = join(journal.directory, 'manifest.json');
        const manifest = await fs.readFile(manifestPath, 'utf8').catch(() => null);
        if (manifest && edge.startsWith('target.'))
          expect(JSON.parse(manifest).intents[0].status).toBe('pending');
      }
    },
    20_000,
  );

  it('stops before target rename on ancestor/manifest/lease ownership drift', async () => {
    const owner = await prepare();
    let changed = false;
    hooks.boundary = async (edge) => {
      if (edge === 'target.rename:before' && !changed) {
        changed = true;
        await fs.appendFile(join(owner.directory, 'manifest.json'), ' ');
      }
    };
    await expect(owner.normalizeCandidate(path, async () => {})).rejects.toThrow(
      'generation/identity drift',
    );
    expect(await fs.readFile(join(root, path))).toEqual(local);
  }, 20_000);

  it.each(['manifest', 'target'])(
    'rechecks the %s temporary before replacing any protected path',
    async (kind) => {
      const owner = await prepare();
      let changed = false;
      hooks.boundary = async (edge) => {
        if (
          changed ||
          edge !==
            (kind === 'target' ? 'target.rename:before' : 'manifest.candidate-intent.rename:before')
        )
          return;
        changed = true;
        if (kind === 'target') {
          const pending = owner.snapshot().intents.find((intent) => intent.status === 'pending')!;
          await fs.writeFile(join(root, pending.details.temporary as string), 'tampered');
        } else {
          const name = (await fs.readdir(owner.directory)).find(
            (name) => name.startsWith('manifest-') && name.endsWith('.tmp'),
          )!;
          await fs.writeFile(join(owner.directory, name), 'tampered');
        }
      };
      await expect(owner.normalizeCandidate(path, async () => {})).rejects.toThrow(
        /temporary changed/,
      );
      expect(changed).toBe(true);
      expect(await fs.readFile(join(root, path))).toEqual(local);
    },
    20_000,
  );

  it.each(['symlink', 'hardlink', 'wrong-mode', 'mixed-eol', 'nested-git', 'missing-parent'])(
    'validates relevant %s paths without capturing unrelated payload',
    async (kind) => {
      if (kind === 'symlink') {
        await fs.rename(join(root, path), join(root, 'kept'));
        await fs.symlink('../kept', join(root, path));
      }
      if (kind === 'hardlink') await fs.link(join(root, path), join(root, 'second-link'));
      if (kind === 'wrong-mode') await fs.chmod(join(root, path), 0o755);
      if (kind === 'mixed-eol') await fs.writeFile(join(root, path), 'human\r\nmixed\n');
      if (kind === 'nested-git') await fs.mkdir(join(root, 'knowledge/.git'));
      if (kind === 'missing-parent') {
        const missing = await observeRecoveryFile(root, 'missing/index.md', true);
        expect(missing.bytes).toBeNull();
        expect(missing.observation.missingAncestor).not.toBeNull();
        return;
      }
      await expect(prepare()).rejects.toThrow();
    },
    20_000,
  );

  it('validates the complete schema and rejects mismatched retained evidence and unknown partial files', async () => {
    const owner = await prepare();
    const record = await readRecoveryManifest(owner.directory);
    expect(() =>
      validateRecoveryManifest({
        version: 1,
        generation: 1,
        phase: 'deferred',
        owner: record.owner,
      }),
    ).toThrow();
    await fs.writeFile(join(owner.directory, record.data[0].file), 'changed');
    await expect(readRecoveryManifest(owner.directory)).rejects.toThrow('evidence changed');
  }, 20_000);
});

describe('inactive recovery finite accounting foundations', () => {
  it('counts incrementally at the exact entry and candidate boundaries', () => {
    const budget = new RecoveryBudget();
    budget.countEntries(RECOVERY_LIMITS.entries - 1);
    budget.countEntries();
    expect(() => budget.countEntries()).toThrow('entry limit');
    for (let index = 0; index < RECOVERY_LIMITS.candidates; index++) budget.countCandidate();
    expect(() => budget.countCandidate()).toThrow('candidate limit');
  });

  it('checks known sizes before allocation and reserves publication/emergency capacity independently', () => {
    const budget = new RecoveryBudget();
    budget.assertIndexBytes(RECOVERY_LIMITS.indexBytes);
    expect(() => budget.assertIndexBytes(RECOVERY_LIMITS.indexBytes + 1)).toThrow('byte limit');
    budget.reserve(RECOVERY_LIMITS.journalBytes - RECOVERY_LIMITS.emergencyBytes);
    expect(() => budget.reserve(1)).toThrow('reservation');
    budget.consume(1);
    expect(() => budget.consume(RECOVERY_LIMITS.journalBytes)).toThrow('Unreserved');
    budget.consumeEmergency(RECOVERY_LIMITS.emergencyBytes);
    expect(() => budget.consumeEmergency(1)).toThrow('emergency');
    const retained = budget.snapshot();
    expect(new RecoveryBudget(undefined, retained).snapshot()).toEqual(retained);
  });

  it('bounds preflight only, preserves old accounting, and rejects invalid counts', () => {
    let now = 10;
    const budget = new RecoveryBudget(() => now);
    now += RECOVERY_LIMITS.preflightMs;
    budget.checkPreflight();
    now++;
    expect(() => budget.countEntries()).toThrow('deadline');
    expect(() => budget.reserve(Number.NaN)).toThrow('Invalid');
    expect(() => budget.assertIndexBytes(-1)).toThrow('Invalid');
    expect(
      () =>
        new RecoveryBudget(undefined, {
          ...budget.snapshot(),
          entries: RECOVERY_LIMITS.entries + 1,
        }),
    ).toThrow('Retained');
    // Ordinary Git/hook runtime is not tied to the preflight clock.
    expect(() => budget.reserve(1)).not.toThrow();
  });
});
