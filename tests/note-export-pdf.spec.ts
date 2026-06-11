import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * End-to-end export pipeline: open a markdown note in the viewer, click
 * "Export as PDF", and assert a real PDF lands at the picked path. The OS
 * save dialog is stubbed in the main process so the run stays headless; the
 * rest — renderer-built HTML document, hidden print window, `printToPDF`,
 * file write — runs for real.
 */
test('Export as PDF prints the open note to the picked path', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    const target = join(booted.conceptionDir, 'exported.pdf');
    await booted.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, target);

    await win.waitForSelector('.row', { state: 'visible', timeout: 5000 });
    await win.click('.row .title');
    await win.waitForSelector('.modal.project-preview', { state: 'visible' });
    await win.click('button[title="Open README"]');
    await win.waitForSelector('.modal.note-modal', { state: 'visible' });

    await win.click('.modal.note-modal button[aria-label="Export as PDF"]');
    // The transient exported-✓ pill appears once the main process reports
    // the written file.
    await win.waitForSelector('.modal.note-modal .modal-saved[title="PDF exported"]', {
      timeout: 15000,
    });

    const pdf = await readFile(target);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  } finally {
    await booted.cleanup();
  }
});

test('the export button is absent in edit mode', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    await win.waitForSelector('.row', { state: 'visible', timeout: 5000 });
    await win.click('.row .title');
    await win.waitForSelector('.modal.project-preview', { state: 'visible' });
    await win.click('button[title="Open README"]');
    await win.waitForSelector('.modal.note-modal', { state: 'visible' });

    await expect(win.locator('.modal.note-modal button[aria-label="Export as PDF"]')).toBeVisible();
    // Switch to edit mode — the affordance only applies to the rendered view.
    await win.click('.modal.note-modal button[aria-label="Switch to edit mode"]');
    await expect(win.locator('.modal.note-modal button[aria-label="Export as PDF"]')).toHaveCount(
      0,
    );
  } finally {
    await booted.cleanup();
  }
});
