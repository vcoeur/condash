/**
 * Lifecycle unit tests for `terminals.ts` (M8c): the spawn wiring and the kill
 * pipeline, driven through the same fake-pty / fake-webContents seam as
 * `terminals-attach.test.ts` (which owns the attach ↔ flow-control coverage).
 *
 * Covers what the extracted pure helpers + the attach seam don't:
 *   - spawn → `onData` fan-out into the rolling buffer, byte counter, and (with
 *     a conception) the disk logger;
 *   - `onExit` ordering — the internals §4 pin that batched output is flushed to
 *     the renderer *before* the `termExit` push, and the exited row lingers until
 *     an explicit close;
 *   - the kill pipeline (§4): SIGTERM the group, a bounded grace, then SIGKILL a
 *     still-alive group — with the PID-recycle guard skipping SIGKILL when the
 *     original pty exited during the grace — plus `killAll` clearing the map.
 *
 * `process.kill` is mocked in the kill tests so no real signal ever leaves the
 * test; the fake pty pids are above Linux's max pid so the afterEach cleanup's
 * real `process.kill` can only ESRCH (never hit a live group). electron,
 * node-pty, the settings / login-shell / memory-scope reads, and — for the
 * conception path — the effective-config read, the disk logger, and the sidecar
 * file writes are all mocked, so no Electron runtime or real pty is involved.
 */
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { WebContents } from 'electron';
import { BATCH_FLUSH_BYTES } from './terminal-flow';
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

interface FakeLogger {
  spawn: ReturnType<typeof vi.fn>;
  output: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => {
  const spawned: FakePty[] = [];
  const loggers: FakeLogger[] = [];
  // Ordered log across the pty-onExit path: logger calls (pushed by the logger
  // mock) interleaved with renderer sends (pushed by the fake webContents), so
  // the §4 "logger.exit → flush termData → termExit" order is assertable across
  // the two mocks.
  const events: string[] = [];
  // Above Linux's absolute max pid (2^22) so a real `process.kill(-pid, …)` in
  // the afterEach cleanup can only ESRCH — never signal a live process group.
  let nextPid = 2_000_000_000;
  return { spawned, loggers, events, nextPid: () => nextPid++ };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const pty: FakePty = {
      pid: hoisted.nextPid(),
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
vi.mock('./shell-env', () => ({ spawnEnv: vi.fn(async () => ({})) }));
vi.mock('./tab-scope', () => ({
  wrapWithMemoryScope: (program: string, argv: string[]) => ({ program, argv }),
  sampleCgroupMemory: () => undefined,
}));
vi.mock('./effective-config', () => ({
  getEffectiveConceptionConfig: vi.fn(async () => ({})),
}));
vi.mock('./file-transcript', () => ({
  sidecarTranscriptPath: vi.fn(() => '/fake/conception/.condash/transcripts/sid.ndjson'),
  readFileTranscript: vi.fn(() => ''),
}));
vi.mock('./terminal-logger', () => ({
  SessionLogger: vi.fn().mockImplementation(() => {
    const logger: FakeLogger = {
      spawn: vi.fn(),
      output: vi.fn(() => hoisted.events.push('logger.output')),
      input: vi.fn(),
      exit: vi.fn(() => hoisted.events.push('logger.exit')),
      close: vi.fn(async () => undefined),
    };
    hoisted.loggers.push(logger);
    return logger;
  }),
}));
// Keep real fs everywhere except the two write ops a conception spawn/close
// performs (the sidecar mkdir + rm), which we neutralise.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(), rmSync: vi.fn() };
});

import {
  attachTerminal,
  closeSession,
  getTerminalPrefs,
  killAll,
  listTerminalSessions,
  spawnTerminal,
  tabsBytes,
  trackedSessionIds,
  writeTerminal,
} from './terminals';
import { readSettings } from './settings';
import { getEffectiveConceptionConfig } from './effective-config';

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
    send: vi.fn((channel: string) => {
      hoisted.events.push(`send:${channel}`);
    }),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
}

/** Spawn one 'my'-side session with no conception (no disk logger, no sidecar). */
async function spawnSession(wc: FakeWebContents): Promise<{ id: string; pty: FakePty }> {
  const { id } = await spawnTerminal(null, wc as unknown as WebContents, { side: 'my' });
  return { id, pty: hoisted.spawned[hoisted.spawned.length - 1] };
}

/** Spawn one 'my'-side session under a conception, so a (mocked) disk logger is
 *  constructed and wired into the onData / onExit path. */
async function spawnConceptionSession(wc: FakeWebContents): Promise<{ id: string; pty: FakePty }> {
  const { id } = await spawnTerminal('/fake/conception', wc as unknown as WebContents, {
    side: 'my',
  });
  return { id, pty: hoisted.spawned[hoisted.spawned.length - 1] };
}

/** The event channels `wc` received, in send order. */
function sentChannels(wc: FakeWebContents): string[] {
  return wc.send.mock.calls.map(([channel]) => channel as string);
}

let killSpy: MockInstance | null = null;
/** Spy `process.kill`: record every (pid, signal), and let the caller flip the
 *  process group's aliveness — an aliveness probe (`signal === 0`) throws when
 *  dead, mirroring a real ESRCH; actual signals are recorded and swallowed. */
function mockProcessKill(): { killed: Array<string | number>; state: { alive: boolean } } {
  const killed: Array<string | number> = [];
  const state = { alive: true };
  killSpy = vi.spyOn(process, 'kill').mockImplementation(((
    _pid: number,
    signal?: string | number,
  ) => {
    killed.push(signal ?? 0);
    if (signal === 0 && !state.alive) throw new Error('ESRCH');
    return true;
  }) as unknown as typeof process.kill);
  return { killed, state };
}

afterEach(async () => {
  vi.useRealTimers();
  killSpy?.mockRestore();
  killSpy = null;
  // Clear any session this test left in the module-level map. Real process.kill
  // on the out-of-range fake pids only ESRCHes, so this can't signal anything.
  await killAll();
  hoisted.spawned.length = 0;
  hoisted.loggers.length = 0;
  hoisted.events.length = 0;
});

describe('terminals spawn wiring (M8c)', () => {
  it('fans onData out to the rolling buffer and the byte counter', async () => {
    const wc = makeWebContents();
    const { id, pty } = await spawnSession(wc);
    pty.onDataCb!('hello ');
    pty.onDataCb!('world');
    // bytesSeen is monotonic (drives the scheduler growth-gate).
    expect(tabsBytes().get(id)).toBe(11);
    // The rolling buffer captured it — a fresh renderer replays it on re-attach.
    const attach = attachTerminal(id, makeWebContents() as unknown as WebContents);
    expect(attach?.output).toContain('hello world');
  });

  it('with a conception, fans onData into the logger and orders logger.exit before the exit push (§4)', async () => {
    const wc = makeWebContents();
    const { pty } = await spawnConceptionSession(wc);
    expect(hoisted.loggers).toHaveLength(1);
    expect(hoisted.loggers[0].spawn).toHaveBeenCalledTimes(1);

    // A sub-batch chunk stays pending (below BATCH_FLUSH_BYTES) — the logger sees
    // it synchronously, but nothing is sent to the renderer yet.
    pty.onDataCb!('some output');
    expect(hoisted.loggers[0].output).toHaveBeenCalledTimes(1);
    expect(sentChannels(wc)).not.toContain(EVENT_CHANNELS.termData);

    pty.onExitCb!({ exitCode: 2 });
    // §4 order across both mocks: logger.exit, then the flushed termData, then
    // termExit — the renderer never sees the exit ahead of the tab's final bytes.
    const seq = hoisted.events;
    const iOut = seq.indexOf('logger.output');
    const iExit = seq.indexOf('logger.exit');
    const iData = seq.indexOf(`send:${EVENT_CHANNELS.termData}`);
    const iTermExit = seq.indexOf(`send:${EVENT_CHANNELS.termExit}`);
    expect(iOut).toBeGreaterThanOrEqual(0);
    expect(iExit).toBeGreaterThan(iOut);
    expect(iData).toBeGreaterThan(iExit);
    expect(iTermExit).toBeGreaterThan(iData);
  });

  it('delivers batched output before the exit notification, with the exit code (§4)', async () => {
    const wc = makeWebContents();
    const { id, pty } = await spawnSession(wc);
    // Below BATCH_FLUSH_BYTES → held pending until a flush; none has run yet.
    pty.onDataCb!('final tail');
    expect(sentChannels(wc)).not.toContain(EVENT_CHANNELS.termData);

    pty.onExitCb!({ exitCode: 3 });
    const channels = sentChannels(wc);
    const dataIdx = channels.indexOf(EVENT_CHANNELS.termData);
    const exitIdx = channels.indexOf(EVENT_CHANNELS.termExit);
    expect(dataIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThan(dataIdx);
    const exitPayload = wc.send.mock.calls.find(
      ([channel]) => channel === EVENT_CHANNELS.termExit,
    )?.[1];
    expect(exitPayload).toEqual({ id, code: 3 });
  });

  it('a burst past BATCH_FLUSH_BYTES flushes before exit and still orders termData ahead of termExit', async () => {
    const wc = makeWebContents();
    const { pty } = await spawnSession(wc);
    pty.onDataCb!('x'.repeat(BATCH_FLUSH_BYTES)); // flushes immediately (one termData)
    pty.onDataCb!('trailing'); // pending
    pty.onExitCb!({ exitCode: 0 });
    const channels = sentChannels(wc);
    // Two termData sends (the immediate burst + the flushed trailing bytes),
    // both before the single termExit.
    expect(channels.filter((c) => c === EVENT_CHANNELS.termData).length).toBe(2);
    expect(channels.lastIndexOf(EVENT_CHANNELS.termData)).toBeLessThan(
      channels.indexOf(EVENT_CHANNELS.termExit),
    );
  });

  it('keeps the exited session row (with its code) until an explicit close', async () => {
    const wc = makeWebContents();
    const { id, pty } = await spawnSession(wc);
    pty.onExitCb!({ exitCode: 0 });
    const row = listTerminalSessions().find((s) => s.id === id);
    expect(row?.exited).toBe(0);
    expect(trackedSessionIds().has(id)).toBe(true);
    // The pty is nulled on exit — a later write is a no-op, not a throw.
    writeTerminal(id, 'ignored');
    expect(pty.write).not.toHaveBeenCalled();

    await closeSession(id);
    expect(listTerminalSessions().find((s) => s.id === id)).toBeUndefined();
    expect(trackedSessionIds().has(id)).toBe(false);
  });

  it('getTerminalPrefs returns settings.terminal directly and ignores effective config (M14)', async () => {
    const settingsTerminal = { shell: '/bin/zsh', scrollback: 10000 };
    vi.mocked(getEffectiveConceptionConfig).mockClear();
    vi.mocked(readSettings).mockResolvedValueOnce({
      lastConceptionPath: '/fake/conception',
      terminal: settingsTerminal,
    } as unknown as Awaited<ReturnType<typeof readSettings>>);
    vi.mocked(getEffectiveConceptionConfig).mockResolvedValueOnce({
      terminal: { shell: '/bin/override', scrollback: 1 },
    } as unknown as Awaited<ReturnType<typeof getEffectiveConceptionConfig>>);
    const prefs = await getTerminalPrefs();
    expect(prefs).toBe(settingsTerminal);
    expect(getEffectiveConceptionConfig).not.toHaveBeenCalled();
  });
});

describe('terminals kill pipeline (M8c, §4)', () => {
  it('SIGTERMs the group then SIGKILLs a still-alive group after the grace', async () => {
    vi.useFakeTimers();
    const wc = makeWebContents();
    const { id } = await spawnSession(wc);
    const { killed, state } = mockProcessKill();
    state.alive = true; // survives SIGTERM → grace → SIGKILL

    const stop = closeSession(id);
    await vi.advanceTimersByTimeAsync(500);
    await stop;

    expect(killed).toContain('SIGTERM');
    expect(killed).toContain('SIGKILL');
    expect(killed.indexOf('SIGTERM')).toBeLessThan(killed.indexOf('SIGKILL'));
    expect(listTerminalSessions().find((s) => s.id === id)).toBeUndefined();
  });

  it('does not SIGKILL when the pty exited during the grace (PID-recycle guard)', async () => {
    vi.useFakeTimers();
    const wc = makeWebContents();
    const { id, pty } = await spawnSession(wc);
    const { killed, state } = mockProcessKill();
    state.alive = true;

    const stop = closeSession(id);
    // The original pty exits mid-grace; the OS may recycle its pid, so SIGKILL of
    // the (now foreign) group must be skipped.
    pty.onExitCb!({ exitCode: 0 });
    await vi.advanceTimersByTimeAsync(500);
    await stop;

    expect(killed).toContain('SIGTERM');
    expect(killed).not.toContain('SIGKILL');
  });

  it('skips the grace and SIGKILL entirely when the group is already gone after SIGTERM', async () => {
    const wc = makeWebContents();
    const { id } = await spawnSession(wc);
    const { killed, state } = mockProcessKill();
    state.alive = false; // the aliveness probe ESRCHes → nothing left to SIGKILL

    await closeSession(id);

    expect(killed.filter((s) => s === 'SIGTERM')).toHaveLength(1);
    expect(killed).not.toContain('SIGKILL');
    expect(listTerminalSessions().find((s) => s.id === id)).toBeUndefined();
  });

  it('killAll SIGTERMs every session and clears the map', async () => {
    const wc = makeWebContents();
    const a = await spawnSession(wc);
    const b = await spawnSession(wc);
    const { killed, state } = mockProcessKill();
    state.alive = false; // fast path — no grace, no SIGKILL

    await killAll();

    expect(killed.filter((s) => s === 'SIGTERM')).toHaveLength(2);
    expect(listTerminalSessions().filter((s) => s.id === a.id || s.id === b.id)).toHaveLength(0);
  });
});
