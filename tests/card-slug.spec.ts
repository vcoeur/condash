import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

/**
 * The card's slug line.
 *
 * Every project card names its item directly under the title: the short slug
 * (`shortSlug` — the dated prefix stripped, the form the CLI and the
 * `{shortSlug}` action variable take) in faint mono, with the full dated slug
 * kept in the tooltip. The default fixture item is
 * `projects/2026-04/2026-04-26-sample/`.
 */
test('a project card shows its short slug, with the dated slug in the tooltip', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    const card = win.locator('article.row').first();
    await expect(card).toBeVisible();

    const slug = card.locator('.slug');
    await expect(slug).toHaveText('sample');
    await expect(slug).toHaveAttribute('title', 'slug: 2026-04-26-sample');
  } finally {
    await booted.cleanup();
  }
});
