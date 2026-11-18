/**
 * Non-blocking exclusive lock for `condash sync`.
 *
 * The whole single-writer premise rests on this: if only one process is ever
 * inside the stage/commit/push window, the shared `.git/index`, the fan-in
 * `index.md` files, and the push race all stop being contended. A second
 * sweeper that finds the lock held does nothing and exits 0 — the next tick
 * picks the work up.
 *
 * `open(…, 'wx')` is the exclusive-create primitive (same one
 * `create-project.ts` and `note.ts` use to refuse clobbering a file).
 */
import { constants, promises as fs } from 'node:fs';
import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FileHandle } from 'node:fs/promises';

const LOCK_BASENAME = 'condash-sync.lock';

/** A lock this old is assumed abandoned even if its pid happens to be alive
 *  (pids get reused). A sweep never legitimately runs for an hour. */
const STALE_AFTER_MS = 60 * 60 * 1000;

export interface LockHolder {
  pid: number;
  startedAt: string;
}

export interface SyncLock {
  path: string;
  token: SyncLockToken;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export interface SyncLockToken extends LockHolder {
  version?: 2;
  purpose?: 'ordinary' | 'recovery';
  transaction?: string | null;
  nonce: string;
  dev: string;
  ino: string;
  bootId: string | null;
  processStart: string | null;
}

export interface RecoveryLease {
  gitDir: string;
  helperPid: number;
  identity: string;
  utility: string;
  assertOwned(): Promise<void>;
  close(): Promise<void>;
}

export interface RecoveryEvidence {
  path: string;
  phase: string | null;
  generation: number | null;
  reason: string;
}

const execFileAsync = promisify(execFile);
const ARBITRATION = 'condash-index-recovery.lock';
const RECOVERY_ROOT = 'condash-index-recovery';
const UTILITY = '/usr/bin/flock';
const HELPER_TIMEOUT_MS = 3000;
const MAX_RECORD_BYTES = 128 * 1024 * 1024;
const promotedLeases = new WeakMap<SyncLock, RecoveryLease>();
const retainedLocks = new WeakSet<SyncLock>();

interface RecoveryTokenHooks {
  boundary?(edge: string, path: string): Promise<void>;
  write?(handle: FileHandle, bytes: Buffer, offset: number): Promise<number>;
  close?(handle: FileHandle): Promise<void>;
}

const LEASE_HELPER = `
const fs = require('node:fs');
const readline = require('node:readline');
const stat = fs.fstatSync(3, {bigint:true});
process.stdout.write(JSON.stringify({ready:true,pid:process.pid,dev:String(stat.dev),ino:String(stat.ino)})+'\\n');
const input = readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line', line => {
  if (!/^CHECK [a-f0-9]{32}$/.test(line)) process.exit(2);
  process.stdout.write(line+'\\n');
});
input.on('close', () => process.stdout.end(() => process.exit(0)));
process.stdin.on('error', () => process.exit(3));
`;

export type AcquireResult =
  | { acquired: true; lock: SyncLock }
  | { acquired: false; heldBy: LockHolder | null };

type RecoveryLeaseResult =
  | { kind: 'acquired'; lease: RecoveryLease }
  | { kind: 'busy' }
  | { kind: 'unavailable' };

interface SyncLockChecks {
  acquireLease?: (gitDir: string) => Promise<RecoveryLeaseResult>;
  boundary?: (point: 'after-create' | 'before-stale-recheck') => Promise<void>;
}

interface RecoveryLeaseHooks {
  creation?: 'existing-only';
  spawnHelper?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  spawned?: (
    child: ChildProcess,
    identity: Awaited<ReturnType<typeof readProcessIdentity>>,
  ) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Try to take the sync lock without blocking.
 *
 * On `EEXIST` the holder is inspected: a dead pid, an unparseable file, or an
 * age past {@link STALE_AFTER_MS} means the previous sweeper died mid-run, so
 * takeover is attempted under arbitration and exclusive create retried once.
 * Missing arbitration retains that stale/dead lock for manual reconciliation.
 * Losing the create retry reports the holder rather than looping.
 *
 * @param gitDir absolute path to the repo's git dir (`git rev-parse --absolute-git-dir`)
 * @returns the acquired lock, or the holder that blocked us (`null` when unreadable)
 * @throws when a stale/dead holder cannot be arbitrated safely
 */
export async function acquireSyncLock(
  gitDir: string,
  checks: SyncLockChecks = {},
): Promise<AcquireResult> {
  await refuseRecoveryEvidence(gitDir);
  const path = join(gitDir, LOCK_BASENAME);

  const first = await tryCreate(path, checks);
  if (first) {
    try {
      await checks.boundary?.('after-create');
      await refuseRecoveryEvidence(gitDir);
      return { acquired: true, lock: first };
    } catch (error) {
      await releaseOwned(first);
      throw error;
    }
  }

  const holder = await readHolder(path);
  if (!(await isStale(path, holder))) return { acquired: false, heldBy: holder };

  const arbitration = await (checks.acquireLease ?? acquireRecoveryLease)(gitDir);
  if (arbitration.kind === 'busy') return { acquired: false, heldBy: holder };
  if (arbitration.kind === 'unavailable')
    throw new Error(
      'Stale sync lock retained: arbitration unavailable; manual reconciliation is required',
    );
  try {
    await checks.boundary?.('before-stale-recheck');
    await refuseRecoveryEvidence(gitDir);
    const currentHolder = await readHolder(path);
    const observed = await optionalStat(path);
    if (!(await isStale(path, currentHolder))) return { acquired: false, heldBy: currentHolder };
    await arbitration.lease.assertOwned();
    await refuseRecoveryEvidence(gitDir);
    const finalStat = await optionalStat(path);
    if (fileIdentity(observed) !== fileIdentity(finalStat))
      return { acquired: false, heldBy: await readHolder(path) };
    if (observed) await fs.unlink(path);
    const second = await tryCreate(path, checks);
    if (!second) return { acquired: false, heldBy: await readHolder(path) };
    try {
      await refuseRecoveryEvidence(gitDir);
      return { acquired: true, lock: second };
    } catch (error) {
      await releaseOwned(second);
      throw error;
    }
  } finally {
    await arbitration.lease.close();
  }
}

/** Create the lock file exclusively, or return null when it already exists. */
async function tryCreate(
  path: string,
  checks: SyncLockChecks = {},
  recovery?: { transaction: string; hooks?: RecoveryTokenHooks },
): Promise<SyncLock | null> {
  let handle;
  try {
    const open = () =>
      fs.open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    handle = recovery
      ? await tokenStep(recovery.hooks, 'token.create.open', path, open)
      : await open();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  let token: SyncLockToken;
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      recovery &&
      (!stat.isFile() ||
        stat.nlink !== 1n ||
        stat.uid !== BigInt(process.getuid!()) ||
        fileIdentity(await optionalStat(path)) !== fileIdentity(stat))
    )
      throw new Error('Unsafe exclusive recovery token');
    const processIdentity = await readProcessIdentity(process.pid);
    token = {
      version: 2,
      purpose: recovery ? 'recovery' : 'ordinary',
      transaction: recovery?.transaction ?? null,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      nonce: randomBytes(16).toString('hex'),
      dev: String(stat.dev),
      ino: String(stat.ino),
      bootId: processIdentity?.bootId ?? null,
      processStart: processIdentity?.processStart ?? null,
    };
    if (recovery) {
      await tokenStep(recovery.hooks, 'token.create.chmod', path, () => handle.chmod(0o600));
      await writeToken(handle, path, token, recovery.hooks, 'token.create');
      await tokenStep(recovery.hooks, 'token.create.fsync', path, () => handle.sync());
    } else await handle.writeFile(JSON.stringify(token) + '\n', 'utf8');
  } finally {
    if (recovery) await closeToken(handle, path, recovery.hooks, 'token.create.close');
    else await handle.close();
  }
  const lock: SyncLock = {
    path,
    token,
    assertOwned: () => assertSyncLockOwned(lock),
    release: async () => {
      if (retainedLocks.has(lock) || lock.token.purpose === 'recovery')
        throw new Error('Recovery publication token is retained; generic release is forbidden');
      const promoted = promotedLeases.get(lock);
      if (promoted) {
        try {
          await promoted.assertOwned();
        } catch {
          // This is cleanup only: replacing a lost helper never restores recovery mutation authority.
          await promoted.close();
          const cleanup = await (checks.acquireLease ?? acquireRecoveryLease)(join(path, '..'));
          if (cleanup.kind !== 'acquired')
            throw new Error(`Owned recovery-lock release requires arbitration: ${cleanup.kind}`);
          try {
            await cleanup.lease.assertOwned();
            await releaseOwned(lock);
          } finally {
            await cleanup.lease.close();
          }
          return;
        }
        await releaseOwned(lock);
        return;
      }
      const arbitration = await (checks.acquireLease ?? acquireRecoveryLease)(join(path, '..'));
      if (arbitration.kind === 'busy') return;
      try {
        // Without arbitration every cooperating takeover refuses; only this still-owned ordinary lock may release.
        if (arbitration.kind === 'acquired') await arbitration.lease.assertOwned();
        await releaseOwned(lock);
      } finally {
        if (arbitration.kind === 'acquired') await arbitration.lease.close();
      }
    },
  };
  if (recovery) {
    retainRecoverySyncLock(lock);
    await tokenStep(recovery.hooks, 'token.create.readback', path, () => lock.assertOwned());
    await syncTokenParent(join(path, '..'), recovery.hooks, 'token.create.parent');
  }
  return lock;
}

/** Transfer cleanup responsibility before the first possibly effective journal operation. */
export function retainRecoverySyncLock(lock: SyncLock): void {
  retainedLocks.add(lock);
}

async function tokenStep<T>(
  hooks: RecoveryTokenHooks | undefined,
  label: string,
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  await hooks?.boundary?.(`${label}:before`, path);
  const value = await operation();
  try {
    await hooks?.boundary?.(`${label}:after`, path);
  } catch (error) {
    if (value && typeof (value as unknown as FileHandle).close === 'function')
      await (value as unknown as FileHandle).close().catch(() => {});
    throw error;
  }
  return value;
}

async function closeToken(
  handle: FileHandle,
  path: string,
  hooks: RecoveryTokenHooks | undefined,
  label: string,
): Promise<void> {
  try {
    await tokenStep(hooks, label, path, () =>
      hooks?.close ? hooks.close(handle) : handle.close(),
    );
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writeToken(
  handle: FileHandle,
  path: string,
  token: SyncLockToken,
  hooks: RecoveryTokenHooks | undefined,
  label: string,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(token) + '\n');
  let offset = 0;
  while (offset < bytes.length) {
    const written = await tokenStep(hooks, `${label}.write`, path, () =>
      hooks?.write
        ? hooks.write(handle, bytes, offset)
        : handle
            .write(bytes, offset, bytes.length - offset, offset)
            .then((result) => result.bytesWritten),
    );
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset)
      throw new Error('Invalid recovery token short write');
    offset += written;
  }
}

async function tokenParent(
  path: string,
  hooks?: RecoveryTokenHooks,
  label = 'token.parent',
): Promise<FileHandle> {
  const before = await optionalStat(path);
  if (
    !before?.isDirectory() ||
    before.uid !== BigInt(process.getuid!()) ||
    (Number(before.mode) & 0o022) !== 0 ||
    (await fs.realpath(path)) !== resolve(path)
  )
    throw new Error('Unsafe recovery token parent');
  const handle = await tokenStep(hooks, `${label}.open`, path, () =>
    fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
  );
  try {
    if (
      fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(before) ||
      fileIdentity(await optionalStat(path)) !== fileIdentity(before)
    )
      throw new Error('Recovery token parent identity drift');
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function syncTokenParent(
  path: string,
  hooks?: RecoveryTokenHooks,
  label = 'token.parent',
): Promise<void> {
  const handle = await tokenParent(path, hooks, label);
  try {
    await tokenStep(hooks, `${label}.fsync`, path, () => handle.sync());
  } finally {
    await closeToken(handle, path, hooks, `${label}.close`);
  }
}

/** Persist recovery purpose only after partial-journal discovery already protects a torn rewrite. */
export async function persistRecoverySyncLock(
  lock: SyncLock,
  lease: RecoveryLease,
  transaction: string,
  hooks?: RecoveryTokenHooks,
): Promise<void> {
  retainRecoverySyncLock(lock);
  if (!/^[a-f0-9]{32}$/.test(transaction)) throw new Error('Invalid recovery token transaction');
  await lease.assertOwned();
  await lock.assertOwned();
  const next: SyncLockToken = { ...lock.token, version: 2, purpose: 'recovery', transaction };
  const handle = await tokenStep(hooks, 'token.purpose.open', lock.path, () =>
    fs.open(lock.path, constants.O_RDWR | constants.O_NOFOLLOW),
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(process.getuid!()) ||
      (Number(stat.mode) & 0o7777) !== 0o600 ||
      String(stat.dev) !== lock.token.dev ||
      String(stat.ino) !== lock.token.ino ||
      fileIdentity(await optionalStat(lock.path)) !== fileIdentity(stat)
    )
      throw new Error('Unsafe recovery purpose token');
    await lease.assertOwned();
    await lock.assertOwned();
    await tokenStep(hooks, 'token.purpose.truncate', lock.path, () => handle.truncate(0));
    await writeToken(handle, lock.path, next, hooks, 'token.purpose');
    Object.assign(lock.token, next);
    await tokenStep(hooks, 'token.purpose.fsync', lock.path, () => handle.sync());
  } finally {
    await closeToken(handle, lock.path, hooks, 'token.purpose.close');
  }
  await tokenStep(hooks, 'token.purpose.readback', lock.path, () => lock.assertOwned());
  await syncTokenParent(lease.gitDir, hooks, 'token.purpose.parent');
  await lease.assertOwned();
  await lock.assertOwned();
}

/** Strictly inspect a current token; legacy tokens are inspection-only beside recovery evidence. */
export async function readSyncLockToken(gitDir: string): Promise<SyncLockToken | null> {
  const path = join(gitDir, LOCK_BASENAME);
  const stat = await optionalStat(path);
  if (!stat) return null;
  if (stat.uid !== BigInt(process.getuid!()) || (Number(stat.mode) & 0o7777) !== 0o600)
    throw new Error('Unsafe sync token ownership/mode');
  const token = JSON.parse(await readSmallRecord(path, 4096));
  if (
    !Number.isSafeInteger(token.pid) ||
    token.pid < 1 ||
    !/^[a-f0-9]{32}$/.test(token.nonce) ||
    token.dev !== String(stat.dev) ||
    token.ino !== String(stat.ino) ||
    typeof token.startedAt !== 'string' ||
    (token.version !== undefined &&
      (token.version !== 2 ||
        !['ordinary', 'recovery'].includes(token.purpose) ||
        (token.purpose === 'ordinary'
          ? token.transaction !== null
          : !/^[a-f0-9]{32}$/.test(token.transaction))))
  )
    throw new Error('Unprovable sync token format/identity');
  return token as SyncLockToken;
}

/** A causal release is legal only from the caller's completed, exact-generation publication capability. */
export async function releaseRecoverySyncLock(
  lock: SyncLock,
  lease: RecoveryLease,
  verifyPublication: () => Promise<void>,
  attempted: () => void,
  hooks?: RecoveryTokenHooks,
): Promise<string | null> {
  if (!retainedLocks.has(lock) || lock.token.purpose !== 'recovery')
    throw new Error('No recovery publication removal capability');
  const parent = await tokenParent(lease.gitDir, hooks, 'token.release.parent');
  let failure: unknown = null;
  let acknowledged = false;
  let attemptedUnlink = false;
  try {
    try {
      await verifyPublication();
      await tokenStep(hooks, 'token.release.unlink', lock.path, async () => {
        await lease.assertOwned();
        await lock.assertOwned();
        attemptedUnlink = true;
        attempted();
        await fs.unlink(lock.path);
        acknowledged = true;
      });
      if (await optionalStat(lock.path)) throw new Error('Recovery token replaced after removal');
    } catch (error) {
      failure = error;
      // Only absence observed after the exact authorized syscall can acknowledge a reported unlink error.
      if (!attemptedUnlink) throw error;
      await lease.assertOwned();
      if (await optionalStat(lock.path)) throw error;
      acknowledged = true;
    }
    if (!acknowledged) throw new Error('Recovery token removal outcome unknown');
    try {
      await tokenStep(hooks, 'token.release.parent.fsync', lease.gitDir, async () => {
        if (
          fileIdentity(await optionalStat(lease.gitDir)) !==
          fileIdentity(await parent.stat({ bigint: true }))
        )
          throw new Error('Recovery removal parent identity changed');
        await parent.sync();
      });
    } catch (error) {
      failure ??= error;
    }
    try {
      await closeToken(parent, lease.gitDir, hooks, 'token.release.parent.close');
    } catch (error) {
      failure ??= error;
    }
    return failure ? String(failure) : null;
  } finally {
    await parent.close().catch(() => {});
  }
}

async function readHolder(path: string): Promise<LockHolder | null> {
  try {
    const raw = await readSmallRecord(path, 4096);
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

/** A lock is stale when we can't attribute it to a live, recent process. */
async function isStale(path: string, holder: LockHolder | null): Promise<boolean> {
  if (!holder) return true;
  if (!isProcessAlive(holder.pid)) return true;
  try {
    const stat = await fs.stat(path);
    return Date.now() - stat.mtimeMs > STALE_AFTER_MS;
  } catch {
    // Vanished between read and stat — someone released it.
    return true;
  }
}

/** `kill(pid, 0)` probes existence. `EPERM` means alive but foreign-owned. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type FileStat = Awaited<ReturnType<typeof optionalStat>>;

async function optionalStat(path: string) {
  return fs.lstat(path, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
}

function fileIdentity(stat: FileStat): string | null {
  return stat ? [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink].join(':') : null;
}

async function readSmallRecord(path: string, maxBytes: number): Promise<string> {
  const before = await optionalStat(path);
  if (!before?.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes))
    throw new Error('Unsupported lock/recovery record');
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(before))
      throw new Error('Lock/recovery record identity drift');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      size !== Number(before.size) ||
      fileIdentity(await optionalStat(path)) !== fileIdentity(before) ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error('Lock/recovery record changed during read');
    const text = bytes.subarray(0, size).toString('utf8');
    if (!Buffer.from(text).equals(bytes.subarray(0, size))) throw new Error('Invalid record UTF-8');
    return text;
  } finally {
    await handle.close();
  }
}

/** Verify Linux boot/start identity rather than treating a reused PID as its old owner. */
export async function readProcessIdentity(pid: number): Promise<{
  bootId: string;
  processStart: string;
} | null> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === 'Z') return null;
    if (!/^\d+$/.test(fields[19]) || !bootId) throw new Error('Ambiguous Linux process identity');
    return { bootId, processStart: fields[19] };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

/** Inspect token bytes and inode immediately before each cooperating mutation. */
export async function assertSyncLockOwned(lock: SyncLock): Promise<void> {
  const stat = await optionalStat(lock.path);
  if (!stat || String(stat.dev) !== lock.token.dev || String(stat.ino) !== lock.token.ino)
    throw new Error('Sync lock ownership lost');
  if (
    lock.token.purpose === 'recovery' &&
    (!stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(process.getuid!()) ||
      (Number(stat.mode) & 0o7777) !== 0o600)
  )
    throw new Error('Unsafe recovery token');
  const current = JSON.parse(await readSmallRecord(lock.path, 4096));
  if (JSON.stringify(current) !== JSON.stringify(lock.token))
    throw new Error('Sync lock token drift');
  if (lock.token.pid !== process.pid) throw new Error('Foreign sync lock owner');
  if (
    lock.token.bootId &&
    JSON.stringify(await readProcessIdentity(process.pid)) !==
      JSON.stringify({ bootId: lock.token.bootId, processStart: lock.token.processStart })
  )
    throw new Error('Sync lock process identity drift');
}

async function releaseOwned(lock: SyncLock): Promise<void> {
  try {
    await assertSyncLockOwned(lock);
  } catch {
    return;
  }
  await fs.unlink(lock.path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

/** Promotion holds arbitration before preparation, then rejects an already stolen ordinary token. */
export async function promoteSyncLock(lock: SyncLock): Promise<RecoveryLease> {
  if (!lock.token.bootId || !lock.token.processStart) throw new Error('Unprovable recovery owner');
  const result = await acquireRecoveryLease(join(lock.path, '..'));
  if (result.kind !== 'acquired') throw new Error(`Recovery arbitration ${result.kind}`);
  try {
    await lock.assertOwned();
    await refuseRecoveryEvidence(join(lock.path, '..'));
    await result.lease.assertOwned();
    promotedLeases.set(lock, result.lease);
    return result.lease;
  } catch (error) {
    await result.lease.close();
    throw error;
  }
}

/** Take a deferred claimant's ordinary token under an already-held lease, never by live-holder age. */
export async function acquireDeferredSyncLock(
  gitDir: string,
  lease: RecoveryLease,
  transaction: string,
  hooks?: RecoveryTokenHooks,
): Promise<SyncLock> {
  await lease.assertOwned();
  if (resolve(gitDir) !== lease.gitDir) throw new Error('Foreign recovery arbitration directory');
  if (await optionalStat(join(gitDir, LOCK_BASENAME)))
    throw new Error('Deferred publication token is present; manual reconciliation required');
  await hooks?.boundary?.('claim.before-token', gitDir);
  const lock = await tryCreate(join(gitDir, LOCK_BASENAME), {}, { transaction, hooks });
  if (!lock) throw new Error('Deferred ordinary lock contention');
  promotedLeases.set(lock, lease);
  await hooks?.boundary?.('claim.after-token', lock.path);
  await lease.assertOwned();
  await lock.assertOwned();
  return lock;
}

/** Administrative token for explicit verified closure only, never automatic recovery or age takeover. */
export async function acquireManualResolutionLock(
  gitDir: string,
  lease: RecoveryLease,
  previousOwner: SyncLockToken | null,
  transaction: string,
  verifyBarrier: () => Promise<void>,
  hooks?: RecoveryTokenHooks,
): Promise<SyncLock> {
  await lease.assertOwned();
  if (resolve(gitDir) !== lease.gitDir) throw new Error('Foreign recovery arbitration directory');
  const path = join(gitDir, LOCK_BASENAME);
  await verifyBarrier();
  const actual = await readSyncLockToken(gitDir);
  if (JSON.stringify(actual) !== JSON.stringify(previousOwner))
    throw new Error('Reviewed administrative token drift');
  if (previousOwner) {
    const stat = await optionalStat(path);
    if (String(stat?.dev) !== previousOwner.dev || String(stat?.ino) !== previousOwner.ino)
      throw new Error('Deferred lock inode drift');
    const record = JSON.parse(await readSmallRecord(path, 4096));
    if (JSON.stringify(record) !== JSON.stringify(previousOwner))
      throw new Error('Deferred lock owner drift');
    if (!previousOwner.bootId || !previousOwner.processStart)
      throw new Error('Ambiguous deferred owner');
    const processIdentity = await readProcessIdentity(previousOwner.pid);
    if (
      processIdentity?.bootId === previousOwner.bootId &&
      processIdentity.processStart === previousOwner.processStart
    )
      throw new Error('Recorded recovery owner still live or PID identity is not releasable');
    await lease.assertOwned();
    await tokenStep(hooks, 'manual.old-token.unlink', path, async () => {
      await verifyBarrier();
      if (JSON.stringify(await readSyncLockToken(gitDir)) !== JSON.stringify(previousOwner))
        throw new Error('Reviewed administrative token changed before removal');
      await fs.unlink(path);
    });
  }
  const lock = await tryCreate(path, {}, { transaction, hooks });
  if (!lock) throw new Error('Deferred ordinary lock contention');
  promotedLeases.set(lock, lease);
  await lease.assertOwned();
  await lock.assertOwned();
  return lock;
}

async function validatePrivateDirectory(path: string): Promise<void> {
  const stat = await optionalStat(path);
  if (
    !stat?.isDirectory() ||
    (Number(stat.mode) & 0o7777) !== 0o700 ||
    stat.uid !== BigInt(process.getuid!()) ||
    (await fs.realpath(path)) !== resolve(path)
  )
    throw new Error('Unsafe recovery directory');
}

/** Discover partial roots, active records and pending archives; only full validated terminal records are nonblocking. */
export async function inspectRecoveryEvidence(
  gitDir: string,
  limits: { maxBytes?: number; maxEntries?: number } = {},
): Promise<RecoveryEvidence[]> {
  const maxBytes = limits.maxBytes ?? MAX_RECORD_BYTES;
  const maxEntries = limits.maxEntries ?? 100_000;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_RECORD_BYTES ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries <= 0 ||
    maxEntries > 100_000
  )
    throw new Error('Invalid recovery discovery limits');
  const root = join(gitDir, RECOVERY_ROOT);
  const rootStat = await optionalStat(root);
  const evidence: RecoveryEvidence[] = [];
  const tokenEvidence: RecoveryEvidence[] = [];
  let currentToken: SyncLockToken | null = null;
  try {
    if (rootStat) currentToken = await readSyncLockToken(gitDir);
    else {
      const path = join(gitDir, LOCK_BASENAME);
      if (await optionalStat(path)) {
        // Preserve legacy malformed/no-journal ordinary takeover policy; explicit recovery purpose is never ordinary.
        const raw = JSON.parse(await readSmallRecord(path, 4096));
        if (
          raw.purpose === 'recovery' ||
          (raw.version !== undefined &&
            (raw.version !== 2 || raw.purpose !== 'ordinary' || raw.transaction !== null))
        )
          currentToken = await readSyncLockToken(gitDir);
      }
    }
    if (currentToken && (currentToken.version !== 2 || currentToken.purpose !== 'ordinary'))
      tokenEvidence.push({
        path: join(gitDir, LOCK_BASENAME),
        phase: null,
        generation: null,
        reason: 'Retained recovery publication token; manual reconciliation required',
      });
  } catch (error) {
    if (rootStat)
      tokenEvidence.push({
        path: join(gitDir, LOCK_BASENAME),
        phase: null,
        generation: null,
        reason: String(error),
      });
    else {
      const raw = await readSmallRecord(join(gitDir, LOCK_BASENAME), 4096).catch(() => '');
      if (/"(?:purpose|version)"/.test(raw))
        tokenEvidence.push({
          path: join(gitDir, LOCK_BASENAME),
          phase: null,
          generation: null,
          reason: String(error),
        });
    }
  }
  if (!rootStat) return tokenEvidence;
  let count = 0;
  let bytes = 0;
  async function inspect(path: string, archive: boolean): Promise<void> {
    try {
      await validatePrivateDirectory(path);
      const manifest = join(path, 'manifest.json');
      const stat = await optionalStat(manifest);
      if (!stat || (Number(stat.mode) & 0o7777) !== 0o600 || stat.uid !== BigInt(process.getuid!()))
        throw new Error('Missing or unsafe recovery manifest');
      bytes += Number(stat.size);
      if (bytes > maxBytes) throw new Error('Recovery discovery byte limit');
      const record = JSON.parse(await readSmallRecord(manifest, maxBytes));
      const valid =
        [1, 2].includes(record.version) &&
        Number.isSafeInteger(record.generation) &&
        record.generation > 0 &&
        typeof record.phase === 'string' &&
        typeof record.owner?.nonce === 'string';
      if (!valid) throw new Error('Invalid recovery manifest header');
      if (archive && record.phase === 'archived') {
        const retainedBytes = record.resources?.usedBytes;
        if (
          !Number.isSafeInteger(retainedBytes) ||
          retainedBytes < Number(stat.size) ||
          bytes - Number(stat.size) + retainedBytes > maxBytes ||
          !Array.isArray(record.data) ||
          !Array.isArray(record.privateDirectories)
        )
          throw new Error('Recovery archive discovery byte limit or invalid inventory');
        bytes += retainedBytes - Number(stat.size);
        if (record.preserved !== undefined && !Array.isArray(record.preserved))
          throw new Error('Invalid preserved recovery inventory');
        count +=
          record.data.length +
          (record.preserved?.length ?? 0) +
          record.privateDirectories.length +
          1;
        if (count > maxEntries) throw new Error('Recovery archive discovery entry limit');
        const { isResolvedRecoveryArchive } = await import('./index-recovery');
        if (await isResolvedRecoveryArchive(path)) return;
        throw new Error('Incomplete terminal recovery archive');
      }
      evidence.push({
        path,
        phase: record.phase,
        generation: record.generation,
        reason: 'Unfinished recovery evidence',
      });
    } catch (error) {
      evidence.push({ path, phase: null, generation: null, reason: String(error) });
    }
  }
  try {
    await validatePrivateDirectory(root);
    let found = false;
    const directory = await fs.opendir(root);
    for await (const entry of directory) {
      if (++count > maxEntries) throw new Error('Recovery discovery entry limit');
      found = true;
      if (entry.name === 'active') await inspect(join(root, entry.name), false);
      else if (entry.name === 'resolved') {
        const resolved = join(root, entry.name);
        await validatePrivateDirectory(resolved);
        let archives = 0;
        for await (const child of await fs.opendir(resolved)) {
          if (++count > maxEntries) throw new Error('Recovery discovery entry limit');
          archives++;
          await inspect(join(resolved, child.name), true);
        }
        if (!archives) throw new Error('Partial empty recovery archive');
      } else throw new Error('Unexpected recovery root entry');
    }
    if (!found) throw new Error('Partial empty recovery root');
  } catch (error) {
    evidence.push({ path: root, phase: null, generation: null, reason: String(error) });
  }
  return [...evidence, ...tokenEvidence];
}

async function refuseRecoveryEvidence(gitDir: string): Promise<void> {
  const evidence = await inspectRecoveryEvidence(gitDir);
  if (evidence.length) throw new Error(`Unresolved index recovery: ${evidence[0].path}`);
}

/** Acquire a supervised Linux flock using a validated inherited inode, without a shell or forked holder. */
export async function acquireRecoveryLease(
  gitDir: string,
  hooks: RecoveryLeaseHooks = {},
): Promise<RecoveryLeaseResult> {
  if (process.platform !== 'linux') return { kind: 'unavailable' };
  const timeoutMs = hooks.timeoutMs ?? HELPER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > HELPER_TIMEOUT_MS)
    throw new Error('Invalid recovery helper deadline');
  let utilityStat: FileStat;
  try {
    utilityStat = await optionalStat(UTILITY);
    if (!utilityStat?.isFile() || (Number(utilityStat.mode) & 0o022) !== 0)
      return { kind: 'unavailable' };
    const { stdout } = await execFileAsync(UTILITY, ['--help'], {
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    if (!stdout.includes('--no-fork') || !stdout.includes('--conflict-exit-code'))
      return { kind: 'unavailable' };
  } catch (error) {
    throw new Error('Recovery arbitration capability could not be established', { cause: error });
  }
  if ((await fs.realpath(gitDir)) !== resolve(gitDir))
    throw new Error('Redirected lease Git directory');
  const path = join(gitDir, ARBITRATION);
  let handle;
  let created = false;
  if (hooks.creation === 'existing-only')
    handle = await fs.open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  else
    try {
      handle = await fs.open(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      handle = await fs.open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    }
  try {
    const stat = await handle.stat({ bigint: true });
    const identity = fileIdentity(stat)!;
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(process.getuid!()) ||
      (Number(stat.mode) & 0o7777) !== 0o600 ||
      fileIdentity(await optionalStat(path)) !== identity
    )
      throw new Error('Unsafe recovery arbitration inode');
    if (created) {
      await handle.sync();
      const parent = await fs.open(
        gitDir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    const child = (hooks.spawnHelper ?? spawn)(
      UTILITY,
      [
        '--exclusive',
        '--nonblock',
        '--conflict-exit-code',
        '73',
        '--no-fork',
        '/proc/self/fd/3',
        process.execPath,
        '-e',
        LEASE_HELPER,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe', handle.fd],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
    const spawnedIdentity = child.pid ? readProcessIdentity(child.pid) : Promise.resolve(null);
    let lost = false;
    let stdoutEnded = false;
    let closed = false;
    let buffer = '';
    let waiter: { resolve(value: string): void; reject(error: Error): void } | null = null;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.once('exit', (code, signal) => {
          lost = true;
          waiter?.reject(new Error('Recovery helper exited'));
          resolveExit({ code, signal });
        });
        child.once('close', (code, signal) => resolveExit({ code, signal }));
      },
    );
    child.on('error', (error) => {
      lost = true;
      waiter?.reject(error);
    });
    child.stdin!.on('error', (error) => {
      lost = true;
      waiter?.reject(error);
    });
    child.stdout!.on('end', () => {
      stdoutEnded = true;
      lost = true;
    });
    child.stderr!.on('data', () => {});
    child.stdout!.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      if (buffer.length > 4096) {
        lost = true;
        waiter?.reject(new Error('Recovery helper response limit'));
        return;
      }
      const end = buffer.indexOf('\n');
      if (end >= 0 && waiter) {
        const active = waiter;
        waiter = null;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        active.resolve(line);
      }
    });
    const line = () =>
      new Promise<string>((resolveLine, rejectLine) => {
        if (lost || waiter) {
          rejectLine(new Error('Recovery helper unavailable'));
          return;
        }
        const timer = setTimeout(() => {
          lost = true;
          waiter = null;
          rejectLine(new Error('Recovery helper deadline'));
        }, timeoutMs);
        waiter = {
          resolve: (value) => {
            clearTimeout(timer);
            resolveLine(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            waiter = null;
            rejectLine(error);
          },
        };
        const end = buffer.indexOf('\n');
        if (end >= 0) {
          const current = waiter;
          waiter = null;
          const value = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          current.resolve(value);
        }
      });
    async function waitExit(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exit,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Recovery helper cleanup deadline')),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    async function stop(abort = false): Promise<void> {
      if (closed) return;
      closed = true;
      lost = true;
      child.stdin!.end();
      if (abort) child.kill('SIGKILL');
      try {
        await waitExit();
      } catch (error) {
        child.kill('SIGKILL');
        await waitExit();
        throw error;
      }
    }
    try {
      const registeredIdentity = await spawnedIdentity;
      await hooks.spawned?.(child, registeredIdentity);
      let ready: string;
      try {
        ready = await line();
      } catch (error) {
        // Pipe EOF can precede waitpid; only the bounded observed exit status proves a flock conflict.
        if (stdoutEnded && child.exitCode === null && child.signalCode === null) await waitExit();
        if (child.exitCode === 73) {
          await stop();
          return { kind: 'busy' };
        }
        throw error;
      }
      const response = JSON.parse(ready);
      if (
        response.ready !== true ||
        response.pid !== child.pid ||
        response.dev !== String(stat.dev) ||
        response.ino !== String(stat.ino)
      )
        throw new Error('Invalid recovery lease handshake');
      const helperIdentity = await readProcessIdentity(child.pid!);
      if (
        !helperIdentity ||
        !registeredIdentity ||
        JSON.stringify(registeredIdentity) !== JSON.stringify(helperIdentity)
      )
        throw new Error('Unprovable recovery helper identity');
      // A second real open must conflict; readiness alone is not a kernel-lease capability proof.
      await new Promise<void>((resolveConflict, rejectConflict) => {
        const contender = spawn(
          UTILITY,
          [
            '--exclusive',
            '--nonblock',
            '--conflict-exit-code',
            '73',
            '/proc/self/fd/3',
            process.execPath,
            '-e',
            'process.exit(0)',
          ],
          {
            stdio: ['ignore', 'ignore', 'ignore', handle.fd],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          },
        );
        const timer = setTimeout(() => {
          contender.kill('SIGKILL');
          rejectConflict(new Error('Lease contender deadline'));
        }, timeoutMs);
        contender.once('error', (failure) => {
          clearTimeout(timer);
          rejectConflict(failure);
        });
        contender.once('exit', (code) => {
          clearTimeout(timer);
          code === 73
            ? resolveConflict()
            : rejectConflict(new Error(`Lease contender result ${code}`));
        });
      });
      const lease: RecoveryLease = {
        gitDir: resolve(gitDir),
        helperPid: child.pid!,
        identity,
        utility: UTILITY,
        assertOwned: async () => {
          const currentUtility = await optionalStat(UTILITY);
          if (
            lost ||
            closed ||
            child.exitCode !== null ||
            child.signalCode !== null ||
            child.stdin!.destroyed ||
            fileIdentity(await optionalStat(path)) !== identity ||
            fileIdentity(currentUtility) !== fileIdentity(utilityStat) ||
            currentUtility?.size !== utilityStat?.size ||
            currentUtility?.mtimeNs !== utilityStat?.mtimeNs ||
            currentUtility?.ctimeNs !== utilityStat?.ctimeNs
          )
            throw new Error('Recovery lease ownership lost');
          if ((await fs.realpath(gitDir)) !== resolve(gitDir))
            throw new Error('Recovery lease ancestor drift');
          if (
            JSON.stringify(await readProcessIdentity(child.pid!)) !== JSON.stringify(helperIdentity)
          )
            throw new Error('Recovery helper identity lost');
          const challenge = `CHECK ${randomBytes(16).toString('hex')}`;
          const reply = line();
          child.stdin!.write(challenge + '\n');
          if ((await reply) !== challenge || lost) throw new Error('Recovery helper liveness lost');
        },
        close: stop,
      };
      await lease.assertOwned();
      return { kind: 'acquired', lease };
    } catch (error) {
      await stop(true);
      throw error;
    }
  } finally {
    await handle.close();
  }
}
