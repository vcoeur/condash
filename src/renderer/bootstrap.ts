import type { BootstrapData } from '@shared/types';

let bootstrapPromise: Promise<BootstrapData> | null = null;

/**
 * Memoized one-shot boot bundle (review finding S6). The first caller fires the
 * `bootstrap` IPC; every mount-time store / hook that follows shares the same
 * in-flight promise, so the whole app boots on ONE settings round-trip instead
 * of the serial `getConceptionPath` gate followed by ~9 parallel settings
 * getters. Live updates flow through the individual setters + tree/config events
 * exactly as before.
 *
 * A rejection is NOT memoized: the slot is cleared when the IPC fails, so the
 * next caller re-fires it. Without this, one failed `bootstrap` round-trip would
 * pin every mount-time store on the rejected promise for the whole session with
 * no retry short of a reload (B2). Each consumer still attaches its own `.catch`
 * to fall back to defaults.
 */
export function getBootstrap(): Promise<BootstrapData> {
  bootstrapPromise ??= window.condash.bootstrap().catch((err: unknown) => {
    bootstrapPromise = null;
    throw err;
  });
  return bootstrapPromise;
}
