import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

/** Two favourite agents + two non-favourites. The dropdown should show
 *  `New shell` + the two favourites (starred) + a `More ▸` row, and hide the
 *  non-favourites until `More ▸` is opened. */
const MIXED_AGENTS = [
  { id: 'fav-alpha', label: 'fav-alpha', command: 'true', favorite: true },
  { id: 'fav-beta', label: 'fav-beta', command: 'true', favorite: true },
  { id: 'other-gamma', label: 'other-gamma', command: 'true' },
  { id: 'other-delta', label: 'other-delta', command: 'true' },
];

/** No favourite marked → the dropdown lists every agent inline (back-compat),
 *  with no star and no `More ▸`. */
const PLAIN_AGENTS = [
  { id: 'one', label: 'one', command: 'true' },
  { id: 'two', label: 'two', command: 'true' },
];

test('favourites show inline + starred; the rest hide behind More ▸', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);

  const booted = await bootApp({ extraConfig: { agents: MIXED_AGENTS } });
  try {
    const win = booted.window;

    const dropdown = win.locator('.terminal-tab-dropdown').first();
    await dropdown.waitFor({ state: 'visible' });
    await dropdown.click();

    const menu = win.locator('.terminal-tab-dropdown-menu');
    await expect(menu).toBeVisible();

    // Primary rows = New shell + 2 favourites + More (direct children only, so
    // the submenu's <li> don't inflate the count once it opens).
    await expect(menu.locator(':scope > li')).toHaveCount(4);
    // A ★ on each favourite, none elsewhere.
    await expect(menu.locator('.terminal-tab-dropdown-star')).toHaveCount(2);
    await expect(menu.getByText('fav-alpha')).toBeVisible();
    await expect(menu.getByText('fav-beta')).toBeVisible();
    await expect(menu.locator('.terminal-tab-dropdown-more')).toBeVisible();

    // Non-favourites are not rendered until the submenu opens.
    await expect(win.getByText('other-gamma')).toHaveCount(0);

    await win.screenshot({ path: testInfo.outputPath('favorites-menu.png'), fullPage: false });
    await testInfo.attach('favorites-menu', {
      path: testInfo.outputPath('favorites-menu.png'),
      contentType: 'image/png',
    });

    // Open the fly-out — the non-favourites appear inside it.
    await win.locator('.terminal-tab-dropdown-more').click();
    const submenu = win.locator('.terminal-tab-dropdown-submenu');
    await expect(submenu).toBeVisible();
    await expect(submenu.locator('li')).toHaveCount(2);
    await expect(submenu.getByText('other-gamma')).toBeVisible();
    await expect(submenu.getByText('other-delta')).toBeVisible();

    await win.screenshot({ path: testInfo.outputPath('favorites-submenu.png'), fullPage: false });
    await testInfo.attach('favorites-submenu', {
      path: testInfo.outputPath('favorites-submenu.png'),
      contentType: 'image/png',
    });

    // Picking an overflow agent spawns it and dismisses the whole menu.
    await submenu.getByText('other-gamma').click();
    await expect(menu).toBeHidden();
  } finally {
    await booted.cleanup();
  }
});

test('with no favourites, every agent lists inline with no More ▸', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);

  const booted = await bootApp({ extraConfig: { agents: PLAIN_AGENTS } });
  try {
    const win = booted.window;

    const dropdown = win.locator('.terminal-tab-dropdown').first();
    await dropdown.waitFor({ state: 'visible' });
    await dropdown.click();

    const menu = win.locator('.terminal-tab-dropdown-menu');
    await expect(menu).toBeVisible();

    // New shell + both agents inline; no More row, no stars.
    await expect(menu.locator(':scope > li')).toHaveCount(3);
    await expect(menu.locator('.terminal-tab-dropdown-more')).toHaveCount(0);
    await expect(menu.locator('.terminal-tab-dropdown-star')).toHaveCount(0);
    await expect(menu.getByText('one')).toBeVisible();
    await expect(menu.getByText('two')).toBeVisible();
  } finally {
    await booted.cleanup();
  }
});
