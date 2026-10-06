import type { ElectronApplication } from '@playwright/test';

/**
 * Test-harness-only interception of an existing `ipcMain.handle` handler:
 * the first `holdCount` invocations are parked until the test releases
 * them; every later invocation delegates to the original handler
 * untouched. Used to replay held/stale IPC replies against the built app
 * — no application code is instrumented.
 *
 * Every `app.evaluate` body is self-contained (evaluate serialises the
 * callback alone); the wrapper state lives on a `globalThis` slot in the
 * main process keyed by channel.
 */

export interface IpcGate {
  /** Invocations seen since install. */
  count(): Promise<number>;
  /** Resolve the call parked at `index` (0 = oldest) with `value`. */
  releaseWithValue(index: number, value: unknown): Promise<void>;
  /** Resolve the call parked at `index` with the ORIGINAL handler's own
   *  (timely, captured at park time) answer — replaying it is what makes
   *  the released reply genuinely stale. */
  releaseWithOriginal(index: number): Promise<void>;
  /** Restore the original handler. */
  uninstall(): Promise<void>;
}

export async function holdFirstCalls(
  app: ElectronApplication,
  channel: string,
  holdCount: number,
): Promise<IpcGate> {
  await app.evaluate(
    ({ ipcMain }, { channel, holdCount }) => {
      const slot = (): Map<
        string,
        {
          original: (event: unknown, ...args: unknown[]) => Promise<unknown>;
          held: {
            event: unknown;
            args: unknown[];
            resolve: (value: unknown) => void;
            timely: Promise<unknown>;
          }[];
          seen: number;
          holdCount: number;
        }
      > => {
        const w = globalThis as typeof globalThis & {
          __condashIpcGates?: Map<
            string,
            {
              original: (event: unknown, ...args: unknown[]) => Promise<unknown>;
              held: {
                event: unknown;
                args: unknown[];
                resolve: (value: unknown) => void;
                timely: Promise<unknown>;
              }[];
              seen: number;
              holdCount: number;
            }
          >;
        };
        if (!w.__condashIpcGates) w.__condashIpcGates = new Map();
        return w.__condashIpcGates;
      };
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>;
        }
      )._invokeHandlers;
      const original = handlers.get(channel);
      if (!original) throw new Error(`no ipcMain handler for ${channel}`);
      const state = {
        original,
        held: [] as {
          event: unknown;
          args: unknown[];
          resolve: (value: unknown) => void;
          timely: Promise<unknown>;
        }[],
        seen: 0,
        holdCount,
      };
      slot().set(channel, state);
      handlers.set(channel, async (event, ...args) => {
        state.seen += 1;
        if (state.seen <= state.holdCount) {
          const timely = original(event, ...args).catch((err: unknown) => ({
            __gateError: err instanceof Error ? err.message : String(err),
          }));
          return new Promise((resolve) => {
            state.held.push({ event, args, resolve, timely });
          });
        }
        return original(event, ...args);
      });
    },
    { channel, holdCount },
  );
  return {
    count: () =>
      app.evaluate((_electron, channel) => {
        const w = globalThis as typeof globalThis & {
          __condashIpcGates?: Map<string, { seen: number }>;
        };
        return w.__condashIpcGates?.get(channel)?.seen ?? -1;
      }, channel) as unknown as Promise<number>,
    releaseWithValue: (index, value) =>
      app.evaluate(
        (_electron, { channel, index, value }) => {
          const w = globalThis as typeof globalThis & {
            __condashIpcGates?: Map<
              string,
              { held: { resolve: (v: unknown) => void }[]; original: unknown }[]
            >;
          };
          const state = w.__condashIpcGates?.get(channel);
          const call = (
            state as unknown as { held: { resolve: (v: unknown) => void }[] }
          )?.held.splice(index, 1)[0];
          if (!call) throw new Error(`no parked call at ${index} for ${channel}`);
          call.resolve(value);
        },
        { channel, index, value },
      ) as unknown as Promise<void>,
    releaseWithOriginal: (index) =>
      app.evaluate(
        async (_electron, { channel, index }) => {
          const w = globalThis as typeof globalThis & {
            __condashIpcGates?: Map<
              string,
              {
                held: { resolve: (v: unknown) => void; timely: Promise<unknown> }[];
                original: unknown;
              }
            >;
          };
          const state = w.__condashIpcGates?.get(channel);
          const call = state?.held.splice(index, 1)[0];
          if (!call) throw new Error(`no parked call at ${index} for ${channel}`);
          call.resolve(await call.timely);
        },
        { channel, index },
      ) as unknown as Promise<void>,
    uninstall: () =>
      app.evaluate(({ ipcMain }, channel) => {
        const w = globalThis as typeof globalThis & {
          __condashIpcGates?: Map<
            string,
            { original: (event: unknown, ...args: unknown[]) => Promise<unknown> }
          >;
        };
        const state = w.__condashIpcGates?.get(channel);
        if (state) {
          (
            ipcMain as unknown as {
              _invokeHandlers: Map<
                string,
                (event: unknown, ...args: unknown[]) => Promise<unknown>
              >;
            }
          )._invokeHandlers.set(channel, state.original);
          w.__condashIpcGates!.delete(channel);
        }
      }, channel) as unknown as Promise<void>,
  };
}
