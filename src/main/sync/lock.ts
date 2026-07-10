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
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

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
  release(): Promise<void>;
}

export type AcquireResult =
  | { acquired: true; lock: SyncLock }
  | { acquired: false; heldBy: LockHolder | null };

/**
 * Try to take the sync lock without blocking.
 *
 * On `EEXIST` the holder is inspected: a dead pid, an unparseable file, or an
 * age past {@link STALE_AFTER_MS} means the previous sweeper died mid-run, so
 * the lock is stolen and the exclusive create retried exactly once. Losing
 * that retry reports the lock as held rather than looping.
 *
 * @param gitDir absolute path to the repo's git dir (`git rev-parse --absolute-git-dir`)
 * @returns the acquired lock, or the holder that blocked us (`null` when unreadable)
 */
export async function acquireSyncLock(gitDir: string): Promise<AcquireResult> {
  const path = join(gitDir, LOCK_BASENAME);

  const first = await tryCreate(path);
  if (first) return { acquired: true, lock: first };

  const holder = await readHolder(path);
  if (!(await isStale(path, holder))) return { acquired: false, heldBy: holder };

  await unlinkIfPresent(path);
  const second = await tryCreate(path);
  // Lost the steal race against another sweeper that judged the same lock
  // stale. Its lock is legitimate; back off.
  if (!second) return { acquired: false, heldBy: await readHolder(path) };
  return { acquired: true, lock: second };
}

/** Create the lock file exclusively, or return null when it already exists. */
async function tryCreate(path: string): Promise<SyncLock | null> {
  let handle;
  try {
    handle = await fs.open(path, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  try {
    const holder: LockHolder = { pid: process.pid, startedAt: new Date().toISOString() };
    await handle.writeFile(JSON.stringify(holder) + '\n', 'utf8');
  } finally {
    await handle.close();
  }
  return { path, release: () => unlinkIfPresent(path) };
}

async function readHolder(path: string): Promise<LockHolder | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
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

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
