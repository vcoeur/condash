import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * End-to-end smoke for the repositories-list section feature:
 *
 *   - "+ Add section" inserts a `{ section: "…" }` entry in condash.json.
 *   - The Code pane groups repos under the section header and the collapse
 *     toggle hides the cards beneath without unmounting anything else.
 *
 * Uses a tiny seeded conception fixture (one project) and a `condash.json`
 * containing two repos plus a section marker between them.
 */

const SEED_REPOS = [
  { section: 'Sites' },
  { name: 'site-one', label: 'Site One' },
  { section: 'Tools' },
  { name: 'tool-one', label: 'Tool One' },
];

test('Settings: + Add section appends a section marker to condash.json', async () => {
  const booted = await bootApp({ extraConfig: { repositories: ['existing-repo'] } });
  try {
    await booted.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send('menu-command', 'open-settings');
    });

    const modal = booted.window.locator('.settings-modal');
    await expect(modal).toBeVisible();
    await modal.locator('[role="tab"]').nth(1).click(); // conception tab
    const conceptionPanel = modal.locator('#settings-panel-conception');
    await expect(conceptionPanel).toBeVisible();

    const reposSection = conceptionPanel.locator(
      'section#settings-section-repositories\\:conception',
    );
    const addSectionBtn = reposSection.locator('button.modal-button', {
      hasText: '+ Add section',
    });
    await addSectionBtn.click();

    const condashPath = join(booted.conceptionDir, '.condash', 'settings.json');
    await expect
      .poll(async () => {
        const parsed = JSON.parse(await readFile(condashPath, 'utf8')) as {
          repositories?: unknown[];
        };
        return parsed.repositories;
      })
      .toEqual(['existing-repo', { section: 'New section' }]);

    // The new section header is rendered inline with a section-marker row.
    await expect(reposSection.locator('.settings-repo-row--section')).toHaveCount(1);
  } finally {
    await booted.cleanup();
  }
});

test('Code pane: section headers group repos and collapse hides their cards', async () => {
  const booted = await bootApp({
    extraConfig: { workspace_path: '/nonexistent/workspace', repositories: SEED_REPOS },
  });
  try {
    // Reveal the Code pane via the menu-command channel. The first
    // `show-code` after boot occasionally drops on the renderer floor
    // (timing race against the initial layout settle), so we retry until
    // the pane mounts.
    const reposPane = booted.window.locator('.repos-pane');
    await expect
      .poll(
        async () => {
          await booted.app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0];
            win.webContents.send('menu-command', 'show-code');
          });
          return reposPane.count();
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    await expect(reposPane).toBeVisible();

    const headers = reposPane.locator('.repos-section-header');
    await expect(headers).toHaveCount(2);
    await expect(headers.nth(0)).toContainText('Sites');
    await expect(headers.nth(1)).toContainText('Tools');

    // Both groups render their cards initially.
    const sitesGroup = reposPane.locator('.repos-section').nth(0);
    const toolsGroup = reposPane.locator('.repos-section').nth(1);
    await expect(sitesGroup.locator('.repos-grid .repo-row')).toHaveCount(1);
    await expect(toolsGroup.locator('.repos-grid .repo-row')).toHaveCount(1);

    // Collapse the first group → its grid disappears, the other stays put.
    await headers.nth(0).click();
    await expect(sitesGroup.locator('.repos-grid')).toHaveCount(0);
    await expect(toolsGroup.locator('.repos-grid .repo-row')).toHaveCount(1);

    // Re-expand → cards come back.
    await headers.nth(0).click();
    await expect(sitesGroup.locator('.repos-grid .repo-row')).toHaveCount(1);
  } finally {
    await booted.cleanup();
  }
});
