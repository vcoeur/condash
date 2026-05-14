import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

/**
 * The Help menu in the toolbar reads its documents out of the asar via the
 * allowlist in `src/main/help.ts`. Since v2.10.5 (`cae83b7`, 2026-05-02
 * "simplify docs site, self-contained Help docs") the menu is six entries:
 * `welcome`, `quick-start`, `shortcuts`, `configuration`, `cli`,
 * `why-markdown` — each short key maps to a single file under `help/`.
 * A typo in the allowlist mapping wouldn't fail the build, only the in-app
 * modal at runtime.
 *
 * This spec asserts that every key in the loader's allowlist resolves to a
 * non-empty document body. It's a near-zero-cost regression net for the
 * "Help menu opens a blank modal" failure mode.
 */
test.describe('Help loader', () => {
  const KEYS = [
    'welcome',
    'quick-start',
    'shortcuts',
    'configuration',
    'cli',
    'why-markdown',
  ] as const;

  for (const key of KEYS) {
    test(`readHelpDoc('${key}') returns a non-empty body`, async () => {
      const booted = await bootApp();
      try {
        const body = await booted.window.evaluate((k) => window.condash.readHelpDoc(k), key);
        expect(typeof body).toBe('string');
        expect((body ?? '').length).toBeGreaterThan(20);
      } finally {
        await booted.cleanup();
      }
    });
  }

  test("cli body mentions the legacy 'condash-cli' alias", async () => {
    const booted = await bootApp();
    try {
      const body = await booted.window.evaluate(() => window.condash.readHelpDoc('cli'));
      // Asserts on a string the live `docs/help/cli.md` body must contain so
      // the help loader is verified to be reading the *current* file, not a
      // stale bundled copy. Picks the legacy-alias mention because it's the
      // most stable token in the file post-unification (v2.24.0).
      expect(body).toMatch(/condash-cli/);
    } finally {
      await booted.cleanup();
    }
  });
});
