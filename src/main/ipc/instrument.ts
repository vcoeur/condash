/**
 * Perf instrumentation for the IPC dispatch surface.
 *
 * Every renderer request runs on the main thread, so a slow handler is a UI
 * stall for the whole app — but the perf log could see only the terminal byte
 * path, and 20 % of the ≥ 100 ms stalls in the 2026-07-22→24 baseline contain
 * under 1 ms of terminal work. Timing dispatch per channel names the ones that
 * are IPC.
 *
 * It is installed by **wrapping `ipcMain.handle` once**, before any handler
 * registers, rather than by editing 120 call sites: a per-site wrapper would
 * have to be remembered for every new verb, and the first forgotten one is a
 * silent hole in exactly the direction (a new, unoptimised handler) the
 * instrument is most likely to be needed.
 */

import { ipcMain } from 'electron';

import { perfLog } from '../perf-log';

/** Anything with an `ipcMain`-shaped `handle`. Structural so the wrapper is
 *  unit-testable against a plain object, with no Electron runtime. */
export interface IpcHandleHost {
  handle(channel: string, listener: (...args: never[]) => unknown): void;
}

/**
 * Channels the instrument refuses to time: its own transport.
 *
 * `perfRendererReport` exists only because recording is on, so timing it would
 * put the instrument's own cost in a field read as the app's — and, worse, make
 * every window contain an IPC dispatch, which is what defeated the idle gate in
 * the first cut of schema 3.
 */
const UNTIMED_CHANNELS: ReadonlySet<string> = new Set(['perfRendererReport']);

/**
 * Wrap one handler so its dispatch wall time lands in the perf log.
 *
 * Three properties matter more than the timing itself:
 * - **Nothing while disabled.** `startSpan()` returns `0n`, and the wrapper then
 *   calls straight through — no `await`, so a disabled build does not even add a
 *   microtask to the ack path (which fires once per delivered `termData`).
 * - **A synchronous handler stays synchronous.** Only a returned promise gets a
 *   `finally`; wrapping every handler in an `async` function would turn every
 *   sync reply into a promise resolution.
 * - **A rejection still records.** The span closes in `finally` / on the
 *   promise's `finally`, so a failing handler's cost is not lost.
 *
 * @param channel IPC channel, used as the record's bucket key.
 * @param listener The original handler.
 * @returns The instrumented handler.
 */
export function withDispatchTiming<A extends never[], R>(
  channel: string,
  listener: (...args: A) => R,
): (...args: A) => R {
  if (UNTIMED_CHANNELS.has(channel)) return listener;
  return (...args: A): R => {
    const span = perfLog.startSpan();
    if (span === 0n) return listener(...args);
    let result: R;
    try {
      result = listener(...args);
    } catch (err) {
      perfLog.endIpc(channel, span);
      throw err;
    }
    if (result instanceof Promise) {
      return result.finally(() => perfLog.endIpc(channel, span)) as R;
    }
    perfLog.endIpc(channel, span);
    return result;
  };
}

/**
 * Replace `host.handle` with a timing wrapper, once.
 *
 * Idempotent: a second call is a no-op, so a re-registration path can never
 * stack two wrappers (which would double-count every channel).
 *
 * @param host The `ipcMain`-shaped object to instrument.
 */
export function installIpcDispatchTiming(host: IpcHandleHost): void {
  const already = installed.get(host);
  if (already) return;
  const original = host.handle.bind(host);
  host.handle = (channel, listener) => original(channel, withDispatchTiming(channel, listener));
  installed.set(host, true);
}

/** Hosts already wrapped, so the install stays idempotent. */
const installed = new WeakMap<IpcHandleHost, boolean>();

/** Install the dispatch timing on the real `ipcMain`. Call before the first
 *  `register*Ipc()` — a handler registered earlier keeps the raw listener and
 *  is simply never timed. */
export function instrumentIpcMain(): void {
  installIpcDispatchTiming(ipcMain as unknown as IpcHandleHost);
}
