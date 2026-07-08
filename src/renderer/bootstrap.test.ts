/**
 * Unit tests for the memoized boot bundle (B2). A successful bootstrap is
 * memoized (one IPC round-trip for the whole app), but a rejection must NOT be —
 * the slot is cleared so the next caller retries instead of every mount-time
 * store being pinned on the rejected promise for the session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapData } from '@shared/types';

type BootstrapFn = () => Promise<BootstrapData>;

function installWindow(bootstrap: BootstrapFn): void {
  (globalThis as unknown as { window: { condash: { bootstrap: BootstrapFn } } }).window = {
    condash: { bootstrap },
  };
}

async function freshModule(): Promise<typeof import('./bootstrap')> {
  vi.resetModules();
  return import('./bootstrap');
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

const fakeBoot = { conceptionPath: '/tree' } as unknown as BootstrapData;

describe('getBootstrap', () => {
  it('memoizes a successful bundle — the IPC fires once for many callers', async () => {
    const bootstrap = vi.fn<BootstrapFn>().mockResolvedValue(fakeBoot);
    installWindow(bootstrap);
    const { getBootstrap } = await freshModule();
    const a = getBootstrap();
    const b = getBootstrap();
    expect(a).toBe(b);
    expect(await a).toBe(fakeBoot);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it('does NOT memoize a rejection — the next caller re-fires the IPC', async () => {
    const bootstrap = vi
      .fn<BootstrapFn>()
      .mockRejectedValueOnce(new Error('bootstrap failed'))
      .mockResolvedValueOnce(fakeBoot);
    installWindow(bootstrap);
    const { getBootstrap } = await freshModule();
    // First attempt rejects…
    await expect(getBootstrap()).rejects.toThrow('bootstrap failed');
    // …and the slot is cleared, so a retry re-fires and succeeds.
    await expect(getBootstrap()).resolves.toBe(fakeBoot);
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });
});
