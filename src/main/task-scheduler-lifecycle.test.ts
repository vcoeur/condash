/**
 * Lifecycle tests for the headless task scheduler:
 *   - E1: a teardown / conception-switch that lands mid-tick must abort the run
 *     before `pty.spawn`, so no background pty is orphaned into a cleared map.
 *   - E2: a `pty.spawn` throw (bad shell → ENOENT) must not leave an unsealed
 *     "running" logger behind — the logger is constructed only after a
 *     successful spawn.
 *
 * The whole spawn surface is mocked so the tick can be driven without a real
 * pty / logger, and `spawnPtyEnv()` is a controllable gate that lets the test hold
 * `runHeadless` open at its last pre-spawn await to simulate a mid-setup teardown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  let resolveGate: ((v: NodeJS.ProcessEnv) => void) | null = null;
  let gate: Promise<NodeJS.ProcessEnv> = Promise.resolve({});
  return {
    ptySpawn: vi.fn(),
    loggerCtor: vi.fn(),
    spawnPtyEnv: vi.fn(() => gate),
    /** Hold the next `spawnPtyEnv()` open (the last await before `pty.spawn`). */
    armGate: () => {
      gate = new Promise((res) => {
        resolveGate = res;
      });
    },
    releaseGate: () => resolveGate?.({}),
    resetGate: () => {
      gate = Promise.resolve({});
      resolveGate = null;
    },
  };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('node-pty', () => ({ spawn: h.ptySpawn }));
vi.mock('./shell-env', () => ({ spawnPtyEnv: h.spawnPtyEnv }));
vi.mock('./terminal-logger', () => ({
  SessionLogger: class {
    constructor(...args: unknown[]) {
      h.loggerCtor(...args);
    }
    spawn(): void {}
    filePath(): string {
      return '/fake/log.txt';
    }
    output(): void {}
    exit(): void {}
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
vi.mock('./tab-scope', () => ({
  wrapWithMemoryScope: (program: string, argv: string[]) => ({ program, argv }),
}));
vi.mock('./terminals', () => ({
  defaultShell: () => '/bin/bash',
  tabsContext: () => [],
  tabsBytes: () => new Map(),
}));
vi.mock('./settings', () => ({ readSettings: vi.fn(async () => ({ terminal: {} })) }));
vi.mock('./agents', () => ({
  listAgents: vi.fn(async () => [
    { id: 'a1', label: 'A', command: 'agedum claude', promptFlags: true },
  ]),
}));
vi.mock('./tasks', () => ({
  readTask: vi.fn(async () => ({ name: 'My Task', agent: 'a1', prompt: 'do it', submit: true })),
}));
vi.mock('./effective-config', () => ({
  getEffectiveConceptionConfig: vi.fn(async () => ({
    taskConfig: { mytask: { schedule: '1s' } },
    terminal: {},
  })),
}));

import { setScheduledConception, tick } from './task-scheduler';

const CONCEPTION = '/tmp/condash-scheduler-lifecycle';

/** A stand-in pty that settles its run immediately via onExit, so a successful
 *  run doesn't leave a pending promise or the timeout timer behind. */
function fakePty(): unknown {
  return {
    pid: 999_999,
    onData: (_cb: (d: string) => void) => {},
    onExit: (cb: (e: { exitCode: number }) => void) => queueMicrotask(() => cb({ exitCode: 0 })),
    kill: () => {},
    write: () => {},
    resize: () => {},
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.ptySpawn.mockReset();
  h.ptySpawn.mockImplementation(() => fakePty());
  h.loggerCtor.mockClear();
  h.spawnPtyEnv.mockClear();
  h.resetGate();
});

afterEach(async () => {
  await setScheduledConception(null);
});

describe('task scheduler lifecycle', () => {
  it('harness sanity: a normal tick spawns and constructs a logger', async () => {
    await setScheduledConception(CONCEPTION);
    await tick(CONCEPTION);
    await vi.waitFor(() => expect(h.ptySpawn).toHaveBeenCalledTimes(1));
    expect(h.loggerCtor).toHaveBeenCalledTimes(1);
  });

  it('aborts before pty.spawn when torn down mid-tick (E1)', async () => {
    h.armGate(); // hold runHeadless at its last await (spawnPtyEnv)
    await setScheduledConception(CONCEPTION);
    void tick(CONCEPTION);
    // Wait until runHeadless has reached the held spawnPtyEnv gate.
    await vi.waitFor(() => expect(h.spawnPtyEnv).toHaveBeenCalled());
    // Tear down mid-setup — this bumps the generation the run captured.
    await setScheduledConception(null);
    // Release the gate; the run resumes and must bail before spawning.
    h.releaseGate();
    await flush();
    expect(h.ptySpawn).not.toHaveBeenCalled();
    expect(h.loggerCtor).not.toHaveBeenCalled();
  });

  it('aborts before pty.spawn when switched to another tree mid-tick (E1)', async () => {
    h.armGate();
    await setScheduledConception(CONCEPTION);
    void tick(CONCEPTION);
    await vi.waitFor(() => expect(h.spawnPtyEnv).toHaveBeenCalled());
    // Switch to a different conception mid-setup.
    await setScheduledConception('/tmp/condash-other-tree');
    h.releaseGate();
    await flush();
    expect(h.ptySpawn).not.toHaveBeenCalled();
  });

  it('does not construct a logger when pty.spawn throws (E2)', async () => {
    h.ptySpawn.mockImplementation(() => {
      throw new Error('ENOENT: bad shell');
    });
    await setScheduledConception(CONCEPTION);
    await tick(CONCEPTION);
    await flush();
    // The spawn was attempted…
    expect(h.ptySpawn).toHaveBeenCalledTimes(1);
    // …and threw, but no logger was constructed, so nothing is left unsealed
    // "running" (the logger is built only after a successful spawn).
    expect(h.loggerCtor).not.toHaveBeenCalled();
  });
});
