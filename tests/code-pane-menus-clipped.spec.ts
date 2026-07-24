import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

/**
 * Repro + regression test for the Code-pane dropdown clip bug (#462).
 *
 * `.repo-row` composes the shared `.card` primitive, which carries
 * `contain: layout paint`. That containment makes the card a containing
 * block for `position: fixed` descendants *and* clips them to its padding
 * box — so the "Open with…" menu and the repo ⋯ menu resolved their
 * viewport coordinates against the card and were then clipped away
 * entirely. The elements kept a non-zero box, so `toBeVisible()` alone
 * passed while nothing was painted; the pixel probe below is what
 * actually discriminates fixed from broken.
 *
 * Post-fix both menus render through `solid-js/web`'s `<Portal>` into
 * `document.body`, escaping every contained ancestor.
 */

const SEED_REPOS = [{ name: 'site-one', label: 'Site One' }];

const OPEN_WITH = {
  main_ide: { label: 'Main IDE', command: 'true' },
  terminal: { label: 'External terminal', command: 'true' },
};

/** Reveal the Code pane. The first `show-code` after boot occasionally
 *  drops on the renderer floor, so retry until the pane mounts. */
async function showCodePane(booted: { app: { evaluate: Function }; window: Page }) {
  const reposPane = booted.window.locator('.repos-pane');
  await expect
    .poll(
      async () => {
        await booted.app.evaluate(({ BrowserWindow }: { BrowserWindow: any }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.webContents.send('menu-command', 'show-code');
        });
        return reposPane.count();
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  await expect(reposPane).toBeVisible();
  return reposPane;
}

/** The menu must have escaped the card and must actually paint: probe a
 *  pixel just inside its top-left corner. */
async function expectEscapedAndPainted(menu: Locator) {
  expect(await menu.evaluate((el) => !el.closest('.repo-row'))).toBe(true);

  const paint = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const probe = document.elementFromPoint(r.left + 10, r.top + 4);
    return {
      hit: el === probe || el.contains(probe as Node),
      position: getComputedStyle(el).position,
      background: getComputedStyle(el).backgroundColor,
    };
  });
  expect(paint.position).toBe('fixed');
  expect(paint.hit).toBe(true);

  // Issue #170: portaling a menu out of its pane made it render with a
  // transparent background, because its surface token was not resolvable
  // from `document.body`. These menus use `:root`-scoped tokens, so the
  // move is safe — assert it rather than assume it.
  expect(paint.background).not.toBe('transparent');
  expect(paint.background).not.toBe('rgba(0, 0, 0, 0)');
  const rgba = paint.background.match(/^rgba\([^)]*,\s*([\d.]+)\)$/);
  if (rgba) expect(parseFloat(rgba[1])).toBe(1);
}

test('Code pane: "Open with…" and repo ⋯ menus escape the contained card and paint', async () => {
  const booted = await bootApp({
    extraConfig: { workspace_path: '/nonexistent/workspace', repositories: SEED_REPOS },
    globalConfig: { open_with: OPEN_WITH },
  });
  try {
    const win = booted.window;
    const reposPane = await showCodePane(booted);

    const card = reposPane.locator('.repo-row').first();
    await expect(card).toBeVisible();

    // The guard is only meaningful while the card really carries the
    // containment this test defends against.
    expect(await card.evaluate((el) => getComputedStyle(el).contain)).toContain('paint');

    // --- "Open with…" chevron (BranchActions) ---
    await card.locator('button[aria-label="Open with…"]').first().click();
    const openWithMenu = win.locator('.branch-action-menu').first();
    await expect(openWithMenu).toBeVisible();
    await expectEscapedAndPainted(openWithMenu);

    // Dismissal still works from the portaled node.
    await win.keyboard.press('Escape');
    await expect(win.locator('.branch-action-menu')).toHaveCount(0);

    // --- repo ⋯ card menu (RepoCardMenu) ---
    await card.locator('.repo-card-menu-trigger').first().click();
    const repoMenu = win.locator('.repo-card-menu').first();
    await expect(repoMenu).toBeVisible();
    await expectEscapedAndPainted(repoMenu);

    await win.keyboard.press('Escape');
    await expect(win.locator('.repo-card-menu')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});
