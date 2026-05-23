import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

/** Seed three valid agent definitions so the spawn dropdown lists
 *  `New shell` + 3 agents = 4 items. */
async function seedThreeAgents(conceptionDir: string): Promise<void> {
  await mkdir(join(conceptionDir, 'agents'), { recursive: true });
  for (const variant of ['alpha', 'beta', 'gamma']) {
    await writeFile(
      join(conceptionDir, 'agents', `opencode-${variant}.json`),
      JSON.stringify({
        harness: 'opencode',
        modelVariant: variant,
        config: { model: `deepseek/${variant}`, disableExternalSkills: true },
      }),
      'utf8',
    );
  }
}

/**
 * Repro + regression test for the "New shell ▼" dropdown clip bug.
 *
 * Pre-fix, the menu was a `position: absolute` child of
 * `.terminal-tab-dropdown-wrap` inside `.terminal-tabs` (overflow:auto).
 * The strip clipped the menu's height down to 32px — users saw only
 * fragments of the menu items and the strip's auto-scrollbar.
 *
 * Post-fix, the menu is rendered through `solid-js/web`'s `<Portal>` to
 * `document.body` so it escapes `.terminal-pane`'s `contain: layout
 * paint` containing block; `position: fixed` then truly anchors to the
 * viewport at the trigger's bottom-left, set by `createDropdownMenu`.
 *
 * Assertions:
 *   - menu has `position: fixed`,
 *   - menu's *painted* bottom-left pixel hits the menu itself
 *     (i.e. no ancestor clip),
 *   - menu is below + roughly left-aligned with the trigger,
 *   - menu has no internal scroll, every `<li>` has non-zero size.
 */
test('spawn dropdown menu is visible + unclipped below the trigger', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);

  const booted = await bootApp({ prepare: seedThreeAgents });
  try {
    const win = booted.window;

    const dropdown = win.locator('.terminal-tab-dropdown').first();
    await dropdown.waitFor({ state: 'visible' });
    const trigRect = await dropdown.boundingBox();
    expect(trigRect).not.toBeNull();

    await dropdown.click();

    const menu = win.locator('.terminal-tab-dropdown-menu');
    await expect(menu).toBeVisible();

    // No ancestor must clip the menu — sample its painted bottom-left.
    const paint = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const probe = document.elementFromPoint(r.left + 10, r.bottom - 4);
      return {
        hitMenu: el === probe || el.contains(probe as Node),
        position: getComputedStyle(el).position,
      };
    });
    expect(paint.position).toBe('fixed');
    expect(paint.hitMenu).toBe(true);

    const menuRect = await menu.boundingBox();
    expect(menuRect).not.toBeNull();
    expect(menuRect!.y).toBeGreaterThanOrEqual(trigRect!.y + trigRect!.height - 1);
    expect(Math.abs(menuRect!.x - trigRect!.x)).toBeLessThan(40);

    // No vertical clipping inside the menu element itself.
    const dims = await menu.evaluate((el) => ({
      scroll: el.scrollHeight,
      client: el.clientHeight,
    }));
    expect(dims.scroll).toBe(dims.client);

    // Issue #170: the dropdown used to render with a transparent background
    // because `.terminal-tab-dropdown-menu.portal` was reaching for the
    // undefined `var(--bg-secondary)`. Surface must be opaque now — alpha
    // must be 1 (an `rgb(...)` reply implies a=1; `rgba(...)` includes it
    // explicitly).
    const surface = await menu.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(surface).not.toBe('transparent');
    expect(surface).not.toBe('rgba(0, 0, 0, 0)');
    const rgba = surface.match(/^rgba\([^)]*,\s*([\d.]+)\)$/);
    if (rgba) expect(parseFloat(rgba[1])).toBe(1);

    const items = menu.locator('li');
    await expect(items).toHaveCount(4);
    for (let i = 0; i < 4; i += 1) {
      const box = await items.nth(i).boundingBox();
      expect(box!.height).toBeGreaterThan(8);
      expect(box!.width).toBeGreaterThan(40);
    }

    await win.screenshot({
      path: testInfo.outputPath('dropdown-open.png'),
      fullPage: false,
    });
    await testInfo.attach('dropdown-open', {
      path: testInfo.outputPath('dropdown-open.png'),
      contentType: 'image/png',
    });
  } finally {
    await booted.cleanup();
  }
});
