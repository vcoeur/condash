import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

/**
 * Search-modal smoke test (M6). Before this spec no Playwright coverage drove
 * the search modal at all — the row components (extracted into
 * `search-modal-parts/`) were reachable only by reading the code.
 *
 * End-to-end path against the standard fixture (one seed project, "Sample
 * project" with summary "Sample fixture project."):
 *   open the modal (the `search` menu command) → type a query that matches the
 *   seed → assert the project result renders → click it → assert it navigates
 *   (the search modal closes and the project-preview popover opens).
 */
test('search modal: query surfaces the seed project and a result opens it', async () => {
  const booted = await bootApp();
  try {
    const { window: win, app } = booted;

    // Dashboard loaded (projects listed → the in-memory search index is built).
    await win.waitForSelector('.row', { state: 'visible', timeout: 5000 });

    // Open the search modal via the same menu command the Search… menu item and
    // the Ctrl+K binding fire (synthetic key events don't drive Electron's
    // native menu accelerators, so dispatch the command directly).
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu-command', 'search');
    });
    await win.waitForSelector('.modal.search-modal', { state: 'visible', timeout: 5000 });

    // Type a query that matches the seed project's title + summary.
    await win.fill('.search-modal-input', 'sample');

    // The seed project surfaces as a project-group header row.
    const projectHeader = win.locator('.search-project-header', { hasText: 'Sample project' });
    await expect(projectHeader).toBeVisible({ timeout: 5000 });

    // Navigate to the result: clicking the header opens the project preview
    // popover and closes the search modal.
    await projectHeader.click();
    await win.waitForSelector('.modal.project-preview', { state: 'visible', timeout: 5000 });
    await win.waitForSelector('.modal.search-modal', { state: 'detached', timeout: 5000 });

    expect(await win.isVisible('.modal.project-preview')).toBe(true);
  } finally {
    await booted.cleanup();
  }
});
