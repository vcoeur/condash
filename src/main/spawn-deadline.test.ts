/**
 * Worker-thread spawn deadline (B3). The corpus finding under test: execFile's
 * `timeout` is a main-process JS timer, so when the event loop is blocked the
 * kill fires late and a 15 s cap stretches to 24 s+. A worker thread's loop is
 * independent of the main thread's, so `armSpawnDeadline` must kill on
 * schedule even while this test's own busy-wait holds the main thread.
 *
 * Liveness is read from a heartbeat file the child rewrites on its own
 * interval, not from the process table: a killed child stays a zombie until
 * the blocked parent loop reaps it, so `process.kill(pid, 0)` would lie.
 */
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { armSpawnDeadline } from './spawn-deadline';
import { exec } from './exec';

const HEARTBEAT_SCRIPT = `
const fs = require('node:fs');
setInterval(() => fs.writeFileSync(process.argv[1], String(Date.now())), 50);
`;

/** Block the main thread for `ms` — the condition the JS-timer timeout fails. */
function busyWait(ms: number): void {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    /* spin */
  }
}

async function startHeartbeatChild(
  dir: string,
): Promise<{ child: ChildProcess; pid: number; hb: string }> {
  const hb = join(dir, `hb-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const child = spawn(process.execPath, ['-e', HEARTBEAT_SCRIPT, hb], { stdio: 'ignore' });
  if (!child.pid) throw new Error('spawn produced no pid');
  // Wait for the first heartbeat so the child is verifiably running.
  for (let i = 0; i < 100; i++) {
    try {
      await fs.readFile(hb, 'utf8');
      return { child, pid: child.pid, hb };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('child never wrote a heartbeat');
}

describe('armSpawnDeadline', () => {
  let dir: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'condash-spawn-deadline-'));
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('kills on schedule even while the main event loop is blocked', async () => {
    const { child, pid, hb } = await startHeartbeatChild(dir);
    children.push(child);
    const preBlock = Date.now();
    armSpawnDeadline(pid, 300);
    busyWait(1500);
    const lastBeat = Number(await fs.readFile(hb, 'utf8'));
    // The heartbeat stopped well before the block ended — the worker killed
    // the child mid-block. A main-loop timer would only fire after busyWait
    // returned (gap ≈ 0), and no kill at all would leave a fresh heartbeat.
    expect(lastBeat).toBeGreaterThan(preBlock);
    expect(Date.now() - lastBeat).toBeGreaterThan(800);
  });

  it('a disarmed deadline leaves the child alive', async () => {
    const { child, pid, hb } = await startHeartbeatChild(dir);
    children.push(child);
    const disarm = armSpawnDeadline(pid, 200);
    disarm();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const lastBeat = Number(await fs.readFile(hb, 'utf8'));
    expect(Date.now() - lastBeat).toBeLessThan(300);
    // (Cleanup: afterEach SIGKILLs the still-alive child.)
  });

  it('kills a hung child at the deadline on a healthy loop', async () => {
    const { child, pid } = await startHeartbeatChild(dir);
    children.push(child);
    armSpawnDeadline(pid, 150);
    const [code, signal] = await once(child, 'exit');
    expect(signal).toBe('SIGTERM');
    expect(code).toBeNull();
  });

  it('disarm is idempotent after the deadline fired', async () => {
    const { child, pid } = await startHeartbeatChild(dir);
    children.push(child);
    const disarm = armSpawnDeadline(pid, 100);
    await once(child, 'exit');
    expect(() => disarm()).not.toThrow();
  });

  it('exec with spawnDeadlineMs rejects when the child is killed at the deadline', async () => {
    // An externally-killed child's error message is the plain "Command
    // failed" form (no signal text), so assert the signal on the error
    // object instead of the message.
    const err = await exec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      spawnDeadlineMs: 200,
      timeout: 10_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException & { signal?: string }).signal).toBe('SIGTERM');
  });
});
