import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

/**
 * Modal back-stack regression net (rc.9 fix). The renderer keeps two pieces
 * of state for "where do I return to when this modal closes":
 *
 *  1. `previewBackPath` — set when a file modal was opened *from* a project
 *     preview popover; closing the file modal restores the preview.
 *  2. `modalStack` — a true stack pushed on each in-modal navigation
 *     (wikilink click, relative .md link); the back button pops one entry.
 *
 * This spec exercises layer (1) end-to-end through the UI: open a project
 * card → click "Open README" → close the README modal → assert the project
 * preview is back. The deeper wikilink-push behaviour is covered by the
 * modal-router unit boundary; this spec is the user-visible smoke test.
 */
test('closing the README modal restores the project preview popover', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;

    // Wait for the dashboard to render (the projects view shows a list of
    // .row cards once `listProjects` resolves).
    await win.waitForSelector('.row', { state: 'visible', timeout: 5000 });

    // Click the seed project's row to open the preview popover.
    await win.click('.row .title');
    await win.waitForSelector('.modal.project-preview', { state: 'visible' });

    // Open the README modal from inside the preview.
    await win.click('button[title="Open README"]');
    await win.waitForSelector('.modal.note-modal', { state: 'visible' });

    // Closing the README modal must restore the project preview popover —
    // *not* leave the user on the bare dashboard. This is the regression
    // case that prompted the back-path tracking in rc.9.
    await win.click('.modal.note-modal .modal-head button[aria-label="Close"]');
    await win.waitForSelector('.modal.note-modal', { state: 'detached' });

    const previewVisible = await win.isVisible('.modal.project-preview');
    expect(previewVisible).toBe(true);
  } finally {
    await booted.cleanup();
  }
});

test('Esc on the README modal also restores the project preview', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;

    await win.waitForSelector('.row', { state: 'visible', timeout: 5000 });
    await win.click('.row .title');
    await win.waitForSelector('.modal.project-preview', { state: 'visible' });
    await win.click('button[title="Open README"]');
    await win.waitForSelector('.modal.note-modal', { state: 'visible' });

    // Click the markdown body so focus is inside the modal, then Esc.
    await win.click('.modal.note-modal');
    await win.keyboard.press('Escape');
    await win.waitForSelector('.modal.note-modal', { state: 'detached' });

    expect(await win.isVisible('.modal.project-preview')).toBe(true);
  } finally {
    await booted.cleanup();
  }
});
