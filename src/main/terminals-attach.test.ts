/**
 * Seam tests for the attach ↔ flow-control wiring in `terminals.ts` (M8a): the
 * path that makes `TerminalFlow` load-bearing. The flow state machine is
 * unit-tested in isolation (`terminal-flow.test.ts`); these drive the real
 * `spawnTerminal` / `attachTerminal` / `resetFlowsForWebContents` / `ackTerminal`
 * with a fake pty + fake webContents, asserting flow reset, re-targeting, epoch
 * stamping (L4), and the dead-frame delivery guard (L2/L3). electron and
 * node-pty are mocked, as are the settings / login-shell / memory-scope reads
 * a spawn touches, so no Electron runtime or real pty is involved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { BATCH_FLUSH_BYTES, HIGH_WATERMARK_BYTES } from './terminal-flow';
import { EVENT_CHANNELS } from '../shared/ipc-channels';

interface FakePty {
  pid: number;
  onDataCb?: (data: string) => void;
  onExitCb?: (e: { exitCode: number }) => void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => {
  const spawned: unknown[] = [];
  return { spawned };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const pty: FakePty = {
      pid: 999_999,
      onData(cb) {
        this.onDataCb = cb;
      },
      onExit(cb) {
        this.onExitCb = cb;
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    hoisted.spawned.push(pty);
    return pty;
  }),
}));
vi.mock('./settings', () => ({
  readSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(async () => undefined),
}));
vi.mock('./shell-env', () => ({
  spawnEnv: vi.fn(async () => ({})),
  spawnPtyEnv: vi.fn(async () => ({ TERM: 'xterm-256color' })),
}));
vi.mock('./tab-scope', () => ({
  wrapWithMemoryScope: (program: string, argv: string[]) => ({ program, argv }),
  cgroupPathFor: () => undefined,
  readCgroupMemory: () => undefined,
  readCgroupMemoryEvents: () => undefined,
}));

import {
  ackTerminal,
  attachTerminal,
  killAll,
  resetFlowsForWebContents,
  spawnTerminal,
  trackedSessionIds,
} from './terminals';

interface FakeWebContents {
  id: number;
  destroyed: boolean;
  crashed: boolean;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  send: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

let nextWcId = 1;
function makeWebContents(): FakeWebContents {
  return {
    id: nextWcId++,
    destroyed: false,
    crashed: false,
    isDestroyed() {
      return this.destroyed;
    },
    isCrashed() {
      return this.crashed;
    },
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
}

/** Spawn one 'my'-side session bound to `wc`; returns its sid and the fake pty
 *  node-pty handed back for it. Null conception → no disk logger, no sidecar. */
async function spawnSession(wc: FakeWebContents): Promise<{ id: string; pty: FakePty }> {
  const { id } = await spawnTerminal(null, wc as unknown as WebContents, { side: 'my' });
  const pty = hoisted.spawned[hoisted.spawned.length - 1] as FakePty;
  return { id, pty };
}

/** One BATCH_FLUSH_BYTES-sized chunk — flushes (and sends) immediately, so the
 *  tests never depend on the coalescing timer. */
const CHUNK = 'x'.repeat(BATCH_FLUSH_BYTES);
/** Chunks needed to push in-flight to the high watermark from zero. */
const CHUNKS_TO_PAUSE = Math.ceil(HIGH_WATERMARK_BYTES / BATCH_FLUSH_BYTES);

/** The termData payloads `wc` received, in order. */
function termDataPayloads(wc: FakeWebContents): { id: string; data: string; epoch: number }[] {
  return wc.send.mock.calls
    .filter(([channel]) => channel === EVENT_CHANNELS.termData)
    .map(([, payload]) => payload as { id: string; data: string; epoch: number });
}

afterEach(async () => {
  // The module-level `sessions` map persists across tests; clear it so one
  // test's spawned sessions don't leak into the next.
  await killAll();
  hoisted.spawned.length = 0;
});

describe('terminals attach ↔ flow seam (M8a)', () => {
  it('sends termData to the spawning webContents, stamped with the flow epoch', async () => {
    const wc = makeWebContents();
    const { id, pty } = await spawnSession(wc);
    pty.onDataCb!(CHUNK);
    const payloads = termDataPayloads(wc);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({ id, data: CHUNK, epoch: 0 });
    expect(trackedSessionIds().has(id)).toBe(true);
  });

  it('attachTerminal resets flow (resumes a paused pty) and re-targets sends', async () => {
    const wc1 = makeWebContents();
    const wc2 = makeWebContents();
    const { id, pty } = await spawnSession(wc1);
    for (let i = 0; i < CHUNKS_TO_PAUSE; i++) pty.onDataCb!(CHUNK);
    expect(pty.pause).toHaveBeenCalledTimes(1);
    // The fresh renderer attaches: the stale in-flight backlog is dropped and
    // the pty resumed — otherwise the never-to-be-acked bytes pin it paused.
    const attach = attachTerminal(id, wc2 as unknown as WebContents);
    expect(pty.resume).toHaveBeenCalledTimes(1);
    expect(attach).not.toBeNull();
    expect(attach!.output.length).toBeGreaterThan(0);
    // Live output now lands in the new webContents, with the bumped epoch.
    pty.onDataCb!(CHUNK);
    const toNew = termDataPayloads(wc2);
    expect(toNew).toHaveLength(1);
    expect(toNew[0].epoch).toBe(1);
    expect(termDataPayloads(wc1)).toHaveLength(CHUNKS_TO_PAUSE); // nothing new to the old one
  });

  it('attachTerminal resets flow on the same-webContents path too (plain reload)', async () => {
    const wc = makeWebContents();
    const { id, pty } = await spawnSession(wc);
    for (let i = 0; i < CHUNKS_TO_PAUSE; i++) pty.onDataCb!(CHUNK);
    expect(pty.pause).toHaveBeenCalledTimes(1);
    // A plain reload reuses the same WebContents (stable id) — the reset must
    // still run before the early same-target return.
    attachTerminal(id, wc as unknown as WebContents);
    expect(pty.resume).toHaveBeenCalledTimes(1);
  });

  it('resetFlowsForWebContents resets every session bound to that frame and no other (L2)', async () => {
    const wc1 = makeWebContents();
    const wc2 = makeWebContents();
    const a = await spawnSession(wc1);
    const b = await spawnSession(wc1);
    const c = await spawnSession(wc2);
    for (const s of [a, b, c]) {
      for (let i = 0; i < CHUNKS_TO_PAUSE; i++) s.pty.onDataCb!(CHUNK);
      expect(s.pty.pause).toHaveBeenCalledTimes(1);
    }
    // The wc1 window re-navigates (reload / crash recovery): both its sessions
    // — including a code-side one nothing re-attaches — resume; wc2's doesn't.
    resetFlowsForWebContents(wc1 as unknown as WebContents);
    expect(a.pty.resume).toHaveBeenCalledTimes(1);
    expect(b.pty.resume).toHaveBeenCalledTimes(1);
    expect(c.pty.resume).not.toHaveBeenCalled();
  });

  it('ignores a stale-epoch ack after a live re-attach (L4)', async () => {
    const wc1 = makeWebContents();
    const wc2 = makeWebContents();
    const { id, pty } = await spawnSession(wc1);
    pty.onDataCb!(CHUNK); // one payload on epoch 0 (below the watermark)
    const staleEpoch = termDataPayloads(wc1)[0].epoch;
    attachTerminal(id, wc2 as unknown as WebContents); // reset → epoch 1
    for (let i = 0; i < CHUNKS_TO_PAUSE; i++) pty.onDataCb!(CHUNK);
    expect(pty.pause).toHaveBeenCalledTimes(1);
    // The old renderer's ack (still in the IPC queue at reset time) arrives
    // late: it must not debit the new epoch's backlog.
    ackTerminal(id, CHUNK.length, staleEpoch);
    expect(pty.resume).not.toHaveBeenCalled();
    // Acks echoing the current epoch drain the backlog and resume as usual.
    const currentEpoch = termDataPayloads(wc2)[0].epoch;
    ackTerminal(id, HIGH_WATERMARK_BYTES, currentEpoch);
    expect(pty.resume).toHaveBeenCalledTimes(1);
  });

  it('does not count bytes sent at a crashed frame, so the pty is never paused on them (L3)', async () => {
    const wc = makeWebContents();
    const { pty } = await spawnSession(wc);
    wc.crashed = true; // disposed-but-not-destroyed frame: safeSend drops payloads
    for (let i = 0; i < CHUNKS_TO_PAUSE * 2; i++) pty.onDataCb!(CHUNK);
    expect(termDataPayloads(wc)).toHaveLength(0);
    expect(pty.pause).not.toHaveBeenCalled();
  });

  it('spawnTerminal kills the pty and throws when the webContents died during the async spawn window (RB1)', async () => {
    const wc = makeWebContents();
    wc.destroyed = true;
    await expect(spawnTerminal(null, wc as unknown as WebContents, { side: 'my' })).rejects.toThrow(
      'Terminal spawn failed: target WebContents was destroyed',
    );
    // The freshly-created pty was killed and the session was never tracked.
    const pty = hoisted.spawned[hoisted.spawned.length - 1] as FakePty;
    expect(pty.kill).toHaveBeenCalled();
    expect(trackedSessionIds().size).toBe(0);
  });

  it('attachTerminal returns null without reassigning when the sender is destroyed (RB1)', async () => {
    const wc1 = makeWebContents();
    const wc2 = makeWebContents();
    wc2.destroyed = true;
    const { id } = await spawnSession(wc1);
    const before = wc1.once.mock.calls.length;
    const attach = attachTerminal(id, wc2 as unknown as WebContents);
    expect(attach).toBeNull();
    // No listener was registered on the destroyed sender, and the existing
    // session remains bound to the original webContents.
    expect(wc2.once).not.toHaveBeenCalled();
    expect(wc1.once.mock.calls.length).toBe(before);
  });
});
