import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

const PROJECT_ACTIONS = [
  { label: 'Claude review', template: 'claude "review project {shortSlug}"', submit: true },
];

const NEW_PROJECT_ACTIONS = [
  { label: 'Spec starter', template: 'start project for {today}:', submit: false },
];

test('project action menu opens and shows configured items', async () => {
  const booted = await bootApp({
    extraConfig: {
      terminal: {
        projectActions: PROJECT_ACTIONS,
        newProjectActions: NEW_PROJECT_ACTIONS,
      },
    },
  });

  try {
    const card = booted.window.locator('.row', { hasText: 'Sample project' }).first();
    await card.waitFor({ state: 'visible' });
    const trigger = card.locator('.action-dropdown-button');
    await expect(trigger).toBeVisible();
    await trigger.click();

    const menu = booted.window.locator('.action-dropdown-menu');
    await menu.waitFor({ state: 'visible' });
    const items = menu.locator('.action-dropdown-menu-item');
    await expect(items).toHaveCount(2);

    // Verify the custom entry label is present.
    await expect(items.filter({ hasText: 'Claude review' })).toBeVisible();
    // Verify the default row is present.
    await expect(items.filter({ hasText: 'Work on' })).toBeVisible();

    // Close menu by pressing Escape.
    await booted.window.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
  } finally {
    await booted.cleanup();
  }
});

test('new project action menu opens and shows configured items', async () => {
  const booted = await bootApp({
    extraConfig: {
      terminal: {
        projectActions: PROJECT_ACTIONS,
        newProjectActions: NEW_PROJECT_ACTIONS,
      },
    },
  });

  try {
    const nowHeader = booted.window
      .locator('.group-block[data-status="now"] .group-header')
      .first();
    const trigger = nowHeader.locator('.action-dropdown-button');
    await expect(trigger).toBeVisible();
    await trigger.click();

    const menu = booted.window.locator('.action-dropdown-menu');
    await menu.waitFor({ state: 'visible' });
    const items = menu.locator('.action-dropdown-menu-item');
    await expect(items).toHaveCount(2);

    await expect(items.filter({ hasText: 'Spec starter' })).toBeVisible();
    await expect(items.filter({ hasText: 'New project' })).toBeVisible();

    await booted.window.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
  } finally {
    await booted.cleanup();
  }
});

test('+ New project button is fully opaque on an empty NOW lane', async () => {
  const booted = await bootApp();
  try {
    const nowBlock = booted.window.locator('.group-block[data-status="now"]').first();
    await nowBlock.waitFor({ state: 'visible' });

    const headerAction = nowBlock.locator('.group-header-action').first();
    const opacity = await headerAction.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.opacity;
    });
    expect(opacity).toBe('1');
  } finally {
    await booted.cleanup();
  }
});
