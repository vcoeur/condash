import { afterEach, describe, expect, it, vi } from 'vitest';

// The engine imports electron (BrowserWindow) at module load and broadcasts via
// getAllWindows(); stub it to an empty window list so the import resolves and
// pushState is a no-op under the node test environment.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

// Make the per-tick config read throw, simulating a malformed
// `.condash/settings.json`, while keeping the rest of ./config real.
vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  return {
    ...actual,
    readDashboardConfig: vi.fn(async () => {
      throw new Error('malformed settings.json');
    }),
  };
});

import { setDashboardConception, tick } from './engine';

const CONCEPTION = '/tmp/condash-engine-test-conception';

afterEach(async () => {
  // Clear the live interval the engine arms so the test process doesn't retain
  // a timer between cases.
  await setDashboardConception(null);
  vi.clearAllMocks();
});

describe('dashboard engine tick', () => {
  it('no-ops instead of rejecting when the config read throws', async () => {
    await setDashboardConception(CONCEPTION);
    // Before the config read moved inside the try/catch this rejected, which —
    // fired as `void tick(...)` from a bare interval — surfaced as an unhandled
    // rejection every interval. The guard must now make the tick a no-op.
    await expect(tick(CONCEPTION)).resolves.toBeUndefined();
  });
});
