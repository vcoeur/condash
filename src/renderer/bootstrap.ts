import type { BootstrapData } from '@shared/types';

let bootstrapPromise: Promise<BootstrapData> | null = null;

/**
 * Memoized one-shot boot bundle (review finding S6). The first caller fires the
 * `bootstrap` IPC; every mount-time store / hook that follows shares the same
 * in-flight promise, so the whole app boots on ONE settings round-trip instead
 * of the serial `getConceptionPath` gate followed by ~9 parallel settings
 * getters. No reset is provided: the bundle is a startup snapshot, and live
 * updates flow through the individual setters + tree/config events exactly as
 * before.
 */
export function getBootstrap(): Promise<BootstrapData> {
  bootstrapPromise ??= window.condash.bootstrap();
  return bootstrapPromise;
}
