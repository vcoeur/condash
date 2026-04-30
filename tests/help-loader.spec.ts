import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

/**
 * The Help menu in the toolbar reads its documents out of the asar via the
 * allowlist in `src/main/help.ts`. The Diátaxis migration (v2.0.6) renamed
 * the on-disk paths but kept the loader's short keys (`architecture`,
 * `configuration`, `non-goals`, `index`) — so a typo in the allowlist
 * mapping wouldn't fail the build, only the in-app modal at runtime.
 *
 * This spec asserts that every key in the loader's allowlist resolves to a
 * non-empty document body. It's a near-zero-cost regression net for the
 * "Help menu opens a blank modal" failure mode.
 */
test.describe('Help loader', () => {
  const KEYS = ['architecture', 'configuration', 'non-goals', 'index'] as const;

  for (const key of KEYS) {
    test(`help.readDoc('${key}') returns a non-empty body`, async () => {
      const booted = await bootApp();
      try {
        const body = await booted.window.evaluate(
          (k) => window.condash.helpReadDoc(k),
          key,
        );
        expect(typeof body).toBe('string');
        expect((body ?? '').length).toBeGreaterThan(20);
      } finally {
        await booted.cleanup();
      }
    });
  }

  test('non-goals body mentions the post-2026-04-30 terminal scope revision', async () => {
    const booted = await bootApp();
    try {
      const body = await booted.window.evaluate(() => window.condash.helpReadDoc('non-goals'));
      // The 2026-04-30 revision adds a "Revision log" section. Asserting on
      // its presence makes sure the help loader is reading the *current*
      // file, not a stale bundled copy.
      expect(body).toMatch(/Revision log/);
    } finally {
      await booted.cleanup();
    }
  });
});
