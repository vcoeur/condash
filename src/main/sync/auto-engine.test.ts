import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mutable holders so the vi.mock factories (also hoisted) can close
// over them and each test can steer the config + syncRun result.
const h = vi.hoisted(() => ({
  config: {
    enabled: false,
    intervalMinutes: 10,
    quietPeriodSeconds: 90,
    push: true,
    integration: 'ff-only',
  },
  throwConfig: false,
  syncRun: vi.fn(),
  notify: vi.fn(),
}));

// The engine imports electron (BrowserWindow) at load and broadcasts via
// getAllWindows(); stub it to an empty window list so pushes are no-ops.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('./notification', () => ({ notifyBlockedSync: h.notify }));

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
  h.config = {
    enabled: false,
    intervalMinutes: 10,
    quietPeriodSeconds: 90,
    push: true,
    integration: 'ff-only',
  };
  h.throwConfig = false;
  h.syncRun.mockReset();
  h.notify.mockReset();
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
      integration: 'ff-only',
    });
    const status = getAutoSyncStatus();
    expect(status.phase).toBe('idle');
    expect(status.lastResult).toEqual({
      committed: 2,
      pushed: true,
      pushError: null,
      diverged: false,
      integrateError: null,
    });
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
    expect(getAutoSyncStatus().lastResult).toEqual({
      committed: 1,
      pushed: true,
      pushError: null,
      diverged: false,
      integrateError: null,
    });
  });

  it('publishes integration-needed when the sweep finds a divergence', async () => {
    await setSyncConception(CONCEPTION);
    h.config = { ...h.config, enabled: true };
    await tick(CONCEPTION); // baseline
    h.syncRun.mockResolvedValue({
      commits: [{}],
      pushed: false,
      pushError: null,
      diverged: true,
      integrateError: null,
    });
    vi.setSystemTime(BASE + 11 * MINUTE);
    await tick(CONCEPTION);
    const status = getAutoSyncStatus();
    expect(status.phase).toBe('integration-needed');
    expect(status.lastError).toBeNull();
    expect(status.lastResult).toEqual({
      committed: 1,
      pushed: false,
      pushError: null,
      diverged: true,
      integrateError: null,
    });
  });

  it('republishes when the integrateError changes between sweeps', async () => {
    await setSyncConception(CONCEPTION);
    h.config = { ...h.config, enabled: true };
    await tick(CONCEPTION); // baseline at BASE, due at BASE + 10 min
    h.syncRun.mockResolvedValue({
      commits: [],
      pushed: false,
      pushError: null,
      diverged: false,
      integrateError: 'fetch failed: network down',
    });
    vi.setSystemTime(BASE + 11 * MINUTE);
    await tick(CONCEPTION);
    expect(getAutoSyncStatus().lastResult?.integrateError).toBe('fetch failed: network down');

    // The next sweep fails differently — a changed integrateError must trigger
    // a fresh publish (sameResult keys on it).
    h.syncRun.mockResolvedValue({
      commits: [],
      pushed: false,
      pushError: null,
      diverged: false,
      integrateError: 'fetch failed: auth denied',
    });
    vi.setSystemTime(BASE + 21 * MINUTE);
    await tick(CONCEPTION);
    const status = getAutoSyncStatus();
    expect(status.phase).toBe('integration-needed');
    expect(status.lastResult).toEqual({
      committed: 0,
      pushed: false,
      pushError: null,
      diverged: false,
      integrateError: 'fetch failed: auth denied',
    });
  });

  it('does nothing once torn down', async () => {
    await setSyncConception(CONCEPTION);
    await setSyncConception(null);
    h.config = { ...h.config, enabled: true };
    await tick(CONCEPTION);
    expect(h.syncRun).not.toHaveBeenCalled();
  });

  it('notifies once across idle/syncing, disable/re-enable and skipped integration', async () => {
    await setSyncConception(CONCEPTION);
    h.config.enabled = true;
    h.syncRun.mockResolvedValue({
      commits: [{}, {}],
      ahead: 7,
      behind: 3,
      diverged: true,
      integrateError: null,
      pushError: null,
    });
    await syncNow();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(CONCEPTION, { since: BASE, waitingCommits: 7 });
    vi.setSystemTime(BASE + MINUTE);
    await tick(CONCEPTION);
    expect(getAutoSyncStatus().phase).toBe('idle');
    expect(getAutoSyncStatus().blockedEpisode?.since).toBe(BASE);
    await syncNow();
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.config.enabled = false;
    await tick(CONCEPTION);
    expect(getAutoSyncStatus().blockedEpisode?.since).toBe(BASE);
    h.config.enabled = true;
    await tick(CONCEPTION);
    h.syncRun.mockResolvedValue({
      commits: [],
      ahead: 7,
      behind: null,
      diverged: false,
      integrateError: null,
      pushError: null,
    });
    await syncNow();
    expect(getAutoSyncStatus().blockedEpisode?.since).toBe(BASE);
    h.syncRun.mockResolvedValue({
      commits: [],
      ahead: 9,
      behind: 4,
      diverged: true,
      integrateError: null,
      pushError: null,
    });
    await syncNow();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(getAutoSyncStatus().blockedEpisode).toEqual({ since: BASE, waitingCommits: 9 });
  });

  it('clears only on verified reconciliation, then notifies a new episode with unknown count', async () => {
    await setSyncConception(CONCEPTION);
    h.syncRun.mockResolvedValue({ commits: [], ahead: 4, behind: 2, diverged: true });
    await syncNow();
    h.syncRun.mockResolvedValue({
      commits: [],
      ahead: 0,
      behind: 0,
      diverged: false,
      pushError: null,
    });
    await syncNow();
    expect(getAutoSyncStatus().blockedEpisode).toBeNull();
    vi.setSystemTime(BASE + MINUTE);
    h.syncRun.mockResolvedValue({
      commits: [],
      ahead: null,
      behind: null,
      integrateError: 'fetch failed',
    });
    await syncNow();
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenLastCalledWith(CONCEPTION, {
      since: BASE + MINUTE,
      waitingCommits: null,
    });
  });

  it('notification failure cannot fail the sweep or repeatedly notify', async () => {
    await setSyncConception(CONCEPTION);
    h.notify.mockImplementation(() => {
      throw new Error('desktop unavailable');
    });
    h.syncRun.mockResolvedValue({
      commits: [],
      ahead: null,
      behind: null,
      integrateError: 'fetch failed',
    });
    await syncNow();
    await syncNow();
    expect(getAutoSyncStatus().phase).toBe('integration-needed');
    expect(getAutoSyncStatus().lastError).toBeNull();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('drops a stale sweep result after switching conception and resets episode suppression', async () => {
    await setSyncConception(CONCEPTION);
    h.syncRun.mockResolvedValue({ commits: [], ahead: 4, behind: 2, diverged: true });
    await syncNow();
    let finish!: (value: unknown) => void;
    h.syncRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = syncNow();
    await Promise.resolve();
    await setSyncConception('/tmp/new-conception');
    finish({ commits: [], ahead: 8, behind: 2, diverged: true });
    await old;
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(getAutoSyncStatus().blockedEpisode).toBeNull();
    h.syncRun.mockResolvedValue({ commits: [], ahead: 1, behind: 2, diverged: true });
    await syncNow();
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenLastCalledWith('/tmp/new-conception', {
      since: BASE,
      waitingCommits: 1,
    });
  });
});
