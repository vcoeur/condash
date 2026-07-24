/**
 * Cover for the IPC dispatch timing wrapper.
 *
 * It sits in front of *every* `ipcMain.handle` in the app, so a mistake here is
 * not a lost counter — it is a broken handler. The three properties under test
 * are the ones that make wrapping the whole surface safe: a synchronous handler
 * stays synchronous, a rejection still propagates (and is still timed), and a
 * second install cannot stack a second wrapper.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { perfLog } from '../perf-log';
import { installIpcDispatchTiming, withDispatchTiming, type IpcHandleHost } from './instrument';

afterEach(() => {
  perfLog.setEnabled(false);
});

/** An `ipcMain`-shaped stub that just remembers what was registered. */
function fakeHost(): IpcHandleHost & { handlers: Map<string, (...args: never[]) => unknown> } {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
}

describe('withDispatchTiming', () => {
  it('returns a synchronous handler synchronously while disabled', () => {
    const wrapped = withDispatchTiming('listRepos', () => 42);
    // Not a promise: an awaited wrapper would add a microtask to every IPC
    // reply, including the per-payload flow-control ack.
    expect(wrapped()).toBe(42);
  });

  it('keeps a synchronous handler synchronous while recording, and times it', () => {
    perfLog.setEnabled(true, '/tmp/does-not-matter');
    const wrapped = withDispatchTiming('listRepos', () => 'ok');
    expect(wrapped()).toBe('ok');

    const ipc = perfLog.takeRecord()?.main?.ipc;
    expect(ipc?.listRepos).toMatchObject({ n: 1 });
  });

  it('times an async handler once it settles', async () => {
    perfLog.setEnabled(true, '/tmp/does-not-matter');
    const wrapped = withDispatchTiming('readNote', async () => {
      await new Promise((resolve) => setTimeout(resolve, 12));
      return 'body';
    });
    await expect(wrapped()).resolves.toBe('body');

    const ipc = perfLog.takeRecord()?.main?.ipc;
    expect(ipc?.readNote.n).toBe(1);
    expect(ipc?.readNote.ms).toBeGreaterThan(5);
  });

  it('records — and re-throws — a synchronous failure', () => {
    perfLog.setEnabled(true, '/tmp/does-not-matter');
    const wrapped = withDispatchTiming('boom', () => {
      throw new Error('nope');
    });
    expect(() => wrapped()).toThrow('nope');
    expect(perfLog.takeRecord()?.main?.ipc?.boom.n).toBe(1);
  });

  it('records — and still rejects — an async failure', async () => {
    perfLog.setEnabled(true, '/tmp/does-not-matter');
    const wrapped = withDispatchTiming('boom', () => Promise.reject(new Error('nope')));
    await expect(wrapped()).rejects.toThrow('nope');
    expect(perfLog.takeRecord()?.main?.ipc?.boom.n).toBe(1);
  });
});

describe('installIpcDispatchTiming', () => {
  it('wraps handlers registered after the install', () => {
    perfLog.setEnabled(true, '/tmp/does-not-matter');
    const host = fakeHost();
    installIpcDispatchTiming(host);
    host.handle('termList', () => 'sessions');

    expect(host.handlers.get('termList')!()).toBe('sessions');
    expect(perfLog.takeRecord()?.main?.ipc?.termList.n).toBe(1);
  });

  it('leaves the instrument’s own transport untimed', () => {
    // Timing `perfRendererReport` would put the instrument's cost in a field
    // read as the app's — and, because the renderer reports every window, it
    // would put an IPC dispatch in every window and make main's idle gate
    // unreachable.
    perfLog.setEnabled(true, '/tmp/does-not-matter');
    const host = fakeHost();
    installIpcDispatchTiming(host);
    host.handle('perfRendererReport', () => ({ recording: true }));
    host.handlers.get('perfRendererReport')!();

    expect(perfLog.takeRecord()?.main?.ipc).toBeUndefined();
  });

  it('is idempotent, so a channel is never double-counted', () => {
    perfLog.setEnabled(true, '/tmp/does-not-matter');
    const host = fakeHost();
    installIpcDispatchTiming(host);
    installIpcDispatchTiming(host);
    host.handle('termList', () => 'sessions');
    host.handlers.get('termList')!();

    expect(perfLog.takeRecord()?.main?.ipc?.termList.n).toBe(1);
  });
});
