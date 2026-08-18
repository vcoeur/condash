import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

/**
 * The line is pinned to one row (`white-space: nowrap` + ellipsis) so a long
 * slug cannot wrap and push the meta row down, nor widen the card. Asserting
 * the CSS declaration would only restate the stylesheet — what matters is the
 * laid-out result, so this measures the rendered box: overflowing content
 * (`scrollWidth > clientWidth`) held inside the card's own width, on a single
 * line of text.
 */
const LONG_SLUG =
  'a-deliberately-overlong-slug-that-no-card-width-can-ever-hope-to-accommodate-in-full';

test('a long slug is clipped to one line instead of wrapping or widening the card', async () => {
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      const dir = join(conceptionDir, 'projects', '2026-04', `2026-04-27-${LONG_SLUG}`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'README.md'),
        `---\ndate: 2026-04-27\nkind: project\nstatus: now\n---\n\n# Long slug fixture\n\n## Goal\n\nFixture for the slug line's overflow behaviour.\n`,
        'utf8',
      );
    },
  });
  try {
    const win = booted.window;
    const slug = win.locator(`article.row .slug[title="slug: 2026-04-27-${LONG_SLUG}"]`);
    await expect(slug).toBeVisible();

    const box = await slug.evaluate((element) => {
      const card = element.closest('article.row') as HTMLElement;
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        height: element.getBoundingClientRect().height,
        cardWidth: card.getBoundingClientRect().width,
        lineHeight,
      };
    });

    // Clipped, not wrapped: content wider than the box, box no taller than one
    // line, and the card itself not stretched to fit the slug.
    expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
    expect(box.height).toBeLessThan(box.lineHeight * 1.6);
    expect(box.clientWidth).toBeLessThanOrEqual(box.cardWidth);
  } finally {
    await booted.cleanup();
  }
});
