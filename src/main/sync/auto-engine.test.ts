import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mutable holders so the vi.mock factories (also hoisted) can close
// over them and each test can steer the config + syncRun result.
const h = vi.hoisted(() => ({
  config: { enabled: false, intervalMinutes: 10, quietPeriodSeconds: 90, push: true },
  throwConfig: false,
  syncRun: vi.fn(),
}));

// The engine imports electron (BrowserWindow) at load and broadcasts via
// getAllWindows(); stub it to an empty window list so pushes are no-ops.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

// Replace the real git-shelling sweeper with a spy.
vi.mock('./run', () => ({
  syncRun: (...args: unknown[]) => h.syncRun(...args),
  SyncRefusedError: class SyncRefusedError extends Error {},
}));

// Keep the real defaults/clamps; only the effective-config read is faked.
vi.mock('./auto-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auto-config')>();
  return {
    ...actual,
    readAutoSyncConfig: async () => {
      if (h.throwConfig) throw new Error('malformed settings.json');
      return h.config;
    },
  };
});

import { getAutoSyncStatus, setSyncConception, syncNow, tick } from './auto-engine';

const CONCEPTION = '/tmp/condash-autosync-test';
const BASE = 1_700_000_000_000;
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  h.config = { enabled: false, intervalMinutes: 10, quietPeriodSeconds: 90, push: true };
  h.throwConfig = false;
  h.syncRun.mockReset();
  h.syncRun.mockResolvedValue({ commits: [], pushed: false, pushError: null });
});

afterEach(async () => {
  await setSyncConception(null);
  vi.useRealTimers();
});

describe('auto-sync engine', () => {
  it('no-ops instead of rejecting when the config read throws', async () => {
    await setSyncConception(CONCEPTION);
    h.throwConfig = true;
    await expect(tick(CONCEPTION)).resolves.toBeUndefined();
    expect(h.syncRun).not.toHaveBeenCalled();
  });

  it('never commits while disabled', async () => {
    await setSyncConception(CONCEPTION);
    await tick(CONCEPTION);
    expect(h.syncRun).not.toHaveBeenCalled();
    expect(getAutoSyncStatus().phase).toBe('disabled');
  });

  it('does not commit on the first enabled tick — it only sets the baseline', async () => {
    await setSyncConception(CONCEPTION);
    h.config = { ...h.config, enabled: true };
    await tick(CONCEPTION);
    expect(h.syncRun).not.toHaveBeenCalled();
    const status = getAutoSyncStatus();
    expect(status.phase).toBe('idle');
    expect(status.nextRunAt).toBe(BASE + 10 * MINUTE);
  });

  it('does not commit before the interval elapses', async () => {
    await setSyncConception(CONCEPTION);
    h.config = { ...h.config, enabled: true };
    await tick(CONCEPTION); // baseline at BASE, due at BASE + 10 min
    vi.setSystemTime(BASE + 5 * MINUTE);
    await tick(CONCEPTION);
    expect(h.syncRun).not.toHaveBeenCalled();
  });

  it('commits once the interval has elapsed, passing the configured options', async () => {
    await setSyncConception(CONCEPTION);
    h.config = { ...h.config, enabled: true };
    await tick(CONCEPTION); // baseline
    h.syncRun.mockResolvedValue({ commits: [{}, {}], pushed: true, pushError: null });
    vi.setSystemTime(BASE + 11 * MINUTE);
    await tick(CONCEPTION);
    expect(h.syncRun).toHaveBeenCalledTimes(1);
    expect(h.syncRun).toHaveBeenCalledWith(CONCEPTION, {
      dryRun: false,
      push: true,
      quietPeriodSeconds: 90,
    });
    const status = getAutoSyncStatus();
    expect(status.phase).toBe('idle');
    expect(status.lastResult).toEqual({ committed: 2, pushed: true, pushError: null });
    expect(status.nextRunAt).toBe(BASE + 11 * MINUTE + 10 * MINUTE);
  });

  it('records a refusal as an error and reschedules instead of hot-looping', async () => {
    await setSyncConception(CONCEPTION);
    h.config = { ...h.config, enabled: true };
    await tick(CONCEPTION); // baseline
    h.syncRun.mockRejectedValue(new Error('merge is in progress'));
    vi.setSystemTime(BASE + 11 * MINUTE);
    await tick(CONCEPTION);
    const status = getAutoSyncStatus();
    expect(status.phase).toBe('error');
    expect(status.lastError).toContain('merge is in progress');
    expect(status.nextRunAt).toBe(BASE + 11 * MINUTE + 10 * MINUTE);
  });

  it('syncNow sweeps immediately, ignoring the cadence and even when disabled', async () => {
    await setSyncConception(CONCEPTION);
    h.config = { ...h.config, enabled: false };
    h.syncRun.mockResolvedValue({ commits: [{}], pushed: true, pushError: null });
    await syncNow();
    expect(h.syncRun).toHaveBeenCalledTimes(1);
    expect(getAutoSyncStatus().lastResult).toEqual({ committed: 1, pushed: true, pushError: null });
  });

  it('does nothing once torn down', async () => {
    await setSyncConception(CONCEPTION);
    await setSyncConception(null);
    h.config = { ...h.config, enabled: true };
    await tick(CONCEPTION);
    expect(h.syncRun).not.toHaveBeenCalled();
  });
});
