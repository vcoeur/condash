import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

/** Two favourites + a long overflow list. 50 non-favourites guarantee a
 *  single-column fly-out would be far taller than the ~800px window — the bug
 *  in the screenshot, where the list ran off the bottom edge with its last
 *  items unreachable. Post-fix the fly-out caps to the viewport band and wraps
 *  into multiple columns instead. */
const FAVORITES = [
  { id: 'fav-alpha', label: 'fav-alpha', command: 'true', favorite: true },
  { id: 'fav-beta', label: 'fav-beta', command: 'true', favorite: true },
];
const OVERFLOW = Array.from({ length: 50 }, (_, i) => ({
  id: `other-${i}`,
  label: `other agent number ${i}`,
  command: 'true',
}));

/**
 * Regression test for the "More ▸" overflow fly-out running off-screen.
 *
 * Pre-fix the submenu was a single `position: absolute` column anchored at the
 * More row; a long agent list spilled past the viewport bottom and the tail
 * items were unreachable.
 *
 * Post-fix the submenu is capped to the viewport band and `flex-flow: column
 * wrap` so it grows sideways into extra columns. JS in column.tsx flips it
 * left / up so the whole box stays inside the viewport.
 *
 * Assertions:
 *   - the whole submenu box sits inside the viewport (no edge spill),
 *   - it wraps into ≥ 2 columns (distinct left-x among the rows),
 *   - every overflow row is fully inside the viewport (all reachable).
 */
test('overflow fly-out wraps into columns and stays inside the viewport', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);

  const booted = await bootApp({ extraConfig: { agents: [...FAVORITES, ...OVERFLOW] } });
  try {
    const win = booted.window;

    const dropdown = win.locator('.terminal-tab-dropdown').first();
    await dropdown.waitFor({ state: 'visible' });
    await dropdown.click();

    const menu = win.locator('.terminal-tab-dropdown-menu');
    await expect(menu).toBeVisible();

    // Open the fly-out.
    await win.locator('.terminal-tab-dropdown-more').click();
    const submenu = win.locator('.terminal-tab-dropdown-submenu');
    await expect(submenu).toBeVisible();
    await expect(submenu.locator('li')).toHaveCount(OVERFLOW.length);

    // Let the rAF-driven placement settle before measuring.
    await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

    const viewport = await win.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));

    // The whole fly-out box stays inside the viewport (1px slack for borders).
    const box = await submenu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.w + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.h + 1);

    // The columns are laid out side-by-side and fully visible — no hidden
    // overflow in either axis (the flex-column-wrap attempt clipped the second
    // column behind a horizontal scrollbar; multicol must not).
    const overflow = await submenu.evaluate((el) => ({
      hiddenX: el.scrollWidth - el.clientWidth,
      hiddenY: el.scrollHeight - el.clientHeight,
    }));
    expect(overflow.hiddenX).toBeLessThanOrEqual(1);
    expect(overflow.hiddenY).toBeLessThanOrEqual(1);

    // Every overflow row is fully inside the viewport — none clipped off-screen.
    const rows = submenu.locator('li');
    const count = await rows.count();
    const lefts = new Set<number>();
    for (let i = 0; i < count; i += 1) {
      const rowBox = await rows.nth(i).boundingBox();
      expect(rowBox).not.toBeNull();
      expect(rowBox!.height).toBeGreaterThan(8);
      expect(rowBox!.width).toBeGreaterThan(40);
      expect(rowBox!.x).toBeGreaterThanOrEqual(-1);
      expect(rowBox!.y).toBeGreaterThanOrEqual(-1);
      expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(viewport.w + 1);
      expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(viewport.h + 1);
      lefts.add(Math.round(rowBox!.x));
    }
    // Multiple columns: the rows occupy at least two distinct left edges.
    expect(lefts.size).toBeGreaterThanOrEqual(2);

    await win.screenshot({ path: testInfo.outputPath('overflow-submenu.png'), fullPage: false });
    await testInfo.attach('overflow-submenu', {
      path: testInfo.outputPath('overflow-submenu.png'),
      contentType: 'image/png',
    });
  } finally {
    await booted.cleanup();
  }
});
