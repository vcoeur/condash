/**
 * Unit tests for the boot repo-prewarm slot (B5). The slot lets the renderer's
 * first `listRepos` reuse the whenReady-time scan, but it must be dropped on a
 * conception switch (and after a TTL) so a later call never awaits a slot warmed
 * for a different tree / a stale boot. An empty effective config means `listRepos`
 * short-circuits to `[]` without touching git, so a config-read counter is a clean
 * proxy for "did a fresh scan run".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getEffectiveConceptionConfig } = vi.hoisted(() => ({
  getEffectiveConceptionConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock('./effective-config', () => ({ getEffectiveConceptionConfig }));

import { clearBootRepos, listReposReusingBoot, prewarmRepos } from './repos';

const PATH_A = '/home/alice/src/vcoeur/conception';
const PATH_B = '/home/alice/src/other-conception';

beforeEach(() => {
  clearBootRepos();
  getEffectiveConceptionConfig.mockClear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('boot repo-prewarm slot (B5)', () => {
  it('reuses the boot scan for the same tree — no second config read', async () => {
    await prewarmRepos(PATH_A);
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(1);
    await listReposReusingBoot(PATH_A);
    // Reused the stashed promise: the config was NOT read a second time.
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a slot after clearBootRepos (conception switch)', async () => {
    await prewarmRepos(PATH_A);
    clearBootRepos();
    await listReposReusingBoot(PATH_A);
    // Slot dropped → a fresh scan ran (second config read).
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a slot warmed for a different tree', async () => {
    await prewarmRepos(PATH_A);
    await listReposReusingBoot(PATH_B);
    // Path mismatch → fresh scan for B.
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(2);
  });

  it('refuses a slot older than the TTL (switch away, switch back much later)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    await prewarmRepos(PATH_A);
    // Jump well past the 30 s TTL — the stale slot must be refused and rescanned.
    vi.setSystemTime(new Date(1_700_000_000_000 + 60_000));
    await listReposReusingBoot(PATH_A);
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(2);
  });

  it('is consumed one-shot — a second reuse call rescans', async () => {
    await prewarmRepos(PATH_A);
    await listReposReusingBoot(PATH_A); // consumes the slot (1 read total)
    await listReposReusingBoot(PATH_A); // slot gone → fresh scan (2 reads)
    expect(getEffectiveConceptionConfig).toHaveBeenCalledTimes(2);
  });
});
