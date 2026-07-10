import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireSyncLock } from './lock';

const LOCK = 'condash-sync.lock';

describe('acquireSyncLock', () => {
  let gitDir: string;

  beforeEach(async () => {
    gitDir = await fs.mkdtemp(join(tmpdir(), 'condash-lock-test-'));
  });

  afterEach(async () => {
    await fs.rm(gitDir, { recursive: true, force: true });
  });

  it('acquires when free and records the holder', async () => {
    const result = await acquireSyncLock(gitDir);
    expect(result.acquired).toBe(true);

    const raw = JSON.parse(await fs.readFile(join(gitDir, LOCK), 'utf8'));
    expect(raw.pid).toBe(process.pid);
    expect(typeof raw.startedAt).toBe('string');
  });

  it('releases so the next caller can acquire', async () => {
    const first = await acquireSyncLock(gitDir);
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    await first.lock.release();

    await expect(fs.stat(join(gitDir, LOCK))).rejects.toThrow();
    const second = await acquireSyncLock(gitDir);
    expect(second.acquired).toBe(true);
  });

  it('refuses when a live process holds it, reporting the holder', async () => {
    // `process.pid` is alive by definition, so this stands in for a running
    // sweeper without needing to fork one.
    await fs.writeFile(
      join(gitDir, LOCK),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const result = await acquireSyncLock(gitDir);
    expect(result.acquired).toBe(false);
    if (result.acquired) return;
    expect(result.heldBy?.pid).toBe(process.pid);
  });

  it('steals a lock whose holder is gone', async () => {
    // pid 2^22 + 1 is above every Linux/macOS pid_max, so it cannot be live.
    await fs.writeFile(
      join(gitDir, LOCK),
      JSON.stringify({ pid: 4_194_305, startedAt: new Date().toISOString() }),
    );

    const result = await acquireSyncLock(gitDir);
    expect(result.acquired).toBe(true);
    const raw = JSON.parse(await fs.readFile(join(gitDir, LOCK), 'utf8'));
    expect(raw.pid).toBe(process.pid);
  });

  it('steals an unparseable lock', async () => {
    await fs.writeFile(join(gitDir, LOCK), 'not json at all');
    const result = await acquireSyncLock(gitDir);
    expect(result.acquired).toBe(true);
  });

  it('steals a lock older than the stale window even if its pid is alive', async () => {
    const lockPath = join(gitDir, LOCK);
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(lockPath, twoHoursAgo, twoHoursAgo);

    const result = await acquireSyncLock(gitDir);
    expect(result.acquired).toBe(true);
  });
});
