import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

/**
 * The status-bar auto-sync + shipped-skills indicators render live state and
 * their actions. The fixture conception is not a git repo and has no installed
 * skills, so the sync snapshot is empty (commits popover shows its empty state)
 * and the shipped-skills indicator prompts to install.
 */
test('status bar shows live auto-sync + shipped-skills indicators', async () => {
  const booted = await bootApp();
  try {
    const bar = booted.window.locator('.status-bar');

    // Auto-sync pill (a state dot + label) + the "Sync now" action.
    const syncPill = bar.locator('.status-pill').first();
    await expect(syncPill).toBeVisible();
    await expect(syncPill.locator('.status-dot')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Sync now' })).toBeVisible();

    // Shipped-skills indicator: nothing installed in the fixture → prompts to
    // install with a state dot + Install action.
    await expect(bar.getByText('Skills: install')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Install' })).toBeVisible();

    // Clicking the auto-sync pill opens the recent-commits popover. The fixture
    // conception is not a git repo, so the commit list is empty.
    await syncPill.click();
    const popover = booted.window.locator('.status-commits');
    await expect(popover).toBeVisible();
    await expect(popover.getByText('No commits yet.')).toBeVisible();

    // The popover must be portalled OUT of the status bar. The status bar has a
    // `backdrop-filter`, which creates a stacking context that would trap the
    // popover's z-index below the workspace and paint it *behind* the code
    // cards. Portalling to the document body is the fix — assert it escaped.
    expect(await popover.evaluate((el) => el.closest('.status-bar') === null)).toBe(true);
  } finally {
    await booted.cleanup();
  }
});

test('blocked episode remains visible during idle and disabled scheduling', async ({}, testInfo) => {
  const booted = await bootApp();
  try {
    for (const phase of ['idle', 'disabled']) {
      await booted.app.evaluate(({ BrowserWindow }, phase) => {
        BrowserWindow.getAllWindows()[0].webContents.send('auto-sync-status', {
          phase,
          enabled: phase === 'idle',
          intervalMinutes: 10,
          lastRunAt: 1_700_000_000_000,
          nextRunAt: null,
          lastResult: null,
          lastError: null,
          blockedEpisode: { since: 1_700_000_000_000, waitingCommits: null },
        });
      }, phase);
      const pill = booted.window.locator('.status-bar .status-pill').first();
      await expect(pill).toHaveText('Integration needed');
      await expect(pill).toHaveAttribute('title', /unknown waiting commits · first detected/);
    }
    await booted.window
      .locator('.status-bar')
      .screenshot({ path: testInfo.outputPath('blocked-episode-status.png') });
  } finally {
    await booted.cleanup();
  }
});
