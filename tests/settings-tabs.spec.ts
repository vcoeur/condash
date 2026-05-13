import { test, expect } from '@playwright/test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Two-tab Settings modal — switching tabs hides the other panel and
 * surfaces the conception-side inheritance badges. Regression cover for
 * the v2.15.0 ship that landed only the section-divider rendering and
 * left tabs + badges out (project 2026-05-08-condash-unified-settings).
 */
test('settings modal: tabs swap panels and badges reflect inheritance', async () => {
  const booted = await bootApp({
    extraConfig: { theme: 'dark' },
  });
  try {
    // Open Settings the same way the File menu does — fire the
    // `open-settings` menu command into the renderer via the same channel
    // the production menu uses. Keyboard accelerators on Electron menus
    // are owned by the OS-app menu, which Playwright can't trigger
    // synthetically; firing the IPC directly mirrors what the click
    // handler ultimately does.
    await booted.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send('menu-command', 'open-settings');
    });

    const modal = booted.window.locator('.settings-modal');
    await expect(modal).toBeVisible();

    // Tablist is present with two tabs; Global is initially active.
    const tablist = modal.locator('[role="tablist"]');
    await expect(tablist).toBeVisible();
    const tabs = tablist.locator('[role="tab"]');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false');

    // Only the global panel is visible (the conception panel is in the DOM
    // but display:none-hidden so drafts and scroll position survive a tab
    // switch).
    const globalPanel = modal.locator('#settings-panel-global');
    const conceptionPanel = modal.locator('#settings-panel-conception');
    await expect(globalPanel).toBeVisible();
    await expect(conceptionPanel).not.toBeVisible();

    // Switch to the conception tab via click.
    await tabs.nth(1).click();
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(globalPanel).not.toBeVisible();
    await expect(conceptionPanel).toBeVisible();

    // The conception tab carries the inheritance badge layer — at minimum
    // one badge per top-level overridable key. The fixture's condash.json
    // sets `theme: 'dark'` (the only key in extraConfig), so the `theme`
    // section should show "Overridden" while every other key shows
    // "Inherits".
    const badges = conceptionPanel.locator('.settings-badge');
    expect(await badges.count()).toBeGreaterThanOrEqual(5);
    // At least one Overridden badge — the fixture's theme override.
    await expect(conceptionPanel.locator('.settings-badge--overridden').first()).toBeVisible();

    // Reset-to-global button shows for overridden keys.
    const resetButton = conceptionPanel.locator('button.settings-remove-override').first();
    await expect(resetButton).toBeVisible();
  } finally {
    await booted.cleanup();
  }
});

test('settings modal: reset-to-global drops the override key from condash.json', async () => {
  const booted = await bootApp({
    extraConfig: { skills_path: 'some/custom/skills' },
  });
  try {
    await booted.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send('menu-command', 'open-settings');
    });
    const modal = booted.window.locator('.settings-modal');
    await expect(modal).toBeVisible();

    // Switch to the conception tab.
    await modal.locator('[role="tab"]').nth(1).click();
    const conceptionPanel = modal.locator('#settings-panel-conception');
    await expect(conceptionPanel).toBeVisible();

    // Find the `skills_path` field by label. Settings.json doesn't
    // declare skills_path, so the conception override (`some/custom/
    // skills`) shows "Overridden" — distinct from the absent global.
    const skillsField = conceptionPanel
      .locator('.settings-field-with-badge', { hasText: 'Skills directory' })
      .first();
    await expect(skillsField.locator('.settings-badge--overridden')).toBeVisible();

    // Click "Reset to global" — the button surfaced for overridden keys.
    const resetButton = skillsField.locator('button.settings-remove-override');
    await resetButton.click();

    // After the click the badge flips to "Inherits" and the key is
    // dropped from condash.json on disk.
    await expect(skillsField.locator('.settings-badge--inherits')).toBeVisible();

    const condashPath = join(booted.conceptionDir, '.condash', 'settings.json');
    await expect
      .poll(async () => {
        const text = await readFile(condashPath, 'utf8');
        const parsed = JSON.parse(text) as Record<string, unknown>;
        return Object.prototype.hasOwnProperty.call(parsed, 'skills_path');
      })
      .toBe(false);
  } finally {
    await booted.cleanup();
  }
});
