import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * The card's slug.
 *
 * Every project card names its item on its head row, right after the star: the
 * short slug (`shortSlug` — the dated prefix stripped, the form the CLI and the
 * `{shortSlug}` action variable take) in faint mono, the date beside it, with
 * the full dated slug kept in the tooltip. The default fixture item is
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
 * The head row is pinned to one line (`white-space: nowrap` + ellipsis on the
 * slug, which is the only item allowed to shrink) so a long slug cannot wrap,
 * push the date or the work-on action off the row, nor widen the card.
 * Asserting the CSS declaration would only restate the stylesheet — what
 * matters is the laid-out result, so this measures the rendered boxes:
 * overflowing content (`scrollWidth > clientWidth`) held inside the card's own
 * width, on a single line of text, with the date and the action still on that
 * same line to its right.
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
      const rect = element.getBoundingClientRect();
      const dateElement = card.querySelector('.date') as HTMLElement;
      const date = dateElement.getBoundingClientRect();
      const action = card.querySelector('.title-actions')!.getBoundingClientRect();
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        height: rect.height,
        centreY: rect.y + rect.height / 2,
        cardWidth: card.getBoundingClientRect().width,
        cardRight: card.getBoundingClientRect().right,
        lineHeight,
        date: {
          centreY: date.y + date.height / 2,
          right: date.right,
          clipped: dateElement.scrollWidth > dateElement.clientWidth,
        },
        action: { centreY: action.y + action.height / 2, right: action.right },
      };
    });

    // Clipped, not wrapped: content wider than the box, box no taller than one
    // line, and the card itself not stretched to fit the slug.
    expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
    expect(box.height).toBeLessThan(box.lineHeight * 1.6);
    expect(box.clientWidth).toBeLessThanOrEqual(box.cardWidth);
    // The date and the work-on action are still on the slug's line, inside
    // the card, and the date kept its full width (it never shrinks).
    expect(box.date.clipped).toBe(false);
    expect(Math.abs(box.date.centreY - box.centreY)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.action.centreY - box.centreY)).toBeLessThanOrEqual(2);
    expect(box.date.right).toBeLessThanOrEqual(box.cardRight);
    expect(box.action.right).toBeLessThanOrEqual(box.cardRight);
  } finally {
    await booted.cleanup();
  }
});
