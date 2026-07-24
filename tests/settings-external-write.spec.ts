/**
 * The Settings modal survives `settings.json` moving under it.
 *
 * The modal captures the file's raw text when it opens and saves through an
 * atomic compare-and-set against that baseline, so ANY other write to the same
 * file while it is open invalidates it: the in-modal Performance-recording
 * toggle (which deliberately writes straight through `perfSetEnabled`), a
 * `condash config set` from a terminal tab, a second window, a hand edit. Every
 * one of those used to reject the user's whole staged batch with a conflict
 * they could not act on — the only exit was to close the modal and lose the
 * edits.
 *
 * Save now three-way merges the draft onto the file's new content and retries
 * once, so the external change and the staged edits both land.
 */

import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp, type BootedApp } from './fixtures/electron-app';

async function openSettings(booted: BootedApp): Promise<Locator> {
  await booted.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.send('menu-command', 'open-settings');
  });
  const modal = booted.window.locator('.settings-modal');
  await expect(modal).toBeVisible();
  await modal.locator('.theme-picker').scrollIntoViewIfNeeded();
  return modal;
}

test('a staged edit survives an external write to settings.json', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  const readGlobal = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(globalPath, 'utf8')) as Record<string, unknown>;
  try {
    const modal = await openSettings(booted);

    // Stage a theme change — the modal now holds a draft against a baseline it
    // captured at open.
    await modal.locator('.theme-card[data-theme-id="console"]').click();
    await expect(modal.locator('button.settings-save')).toBeEnabled();

    // Someone else writes the same file. `pdf_viewer` is a key this modal never
    // edits, so the merge must keep it verbatim rather than reverting it to the
    // stale baseline the draft was seeded from.
    const onDisk = await readGlobal();
    await writeFile(
      globalPath,
      JSON.stringify({ ...onDisk, pdf_viewer: ['zathura'] }, null, 2) + '\n',
      'utf8',
    );

    await modal.locator('button.settings-save').click();

    // No conflict surfaced, and both writes are on disk.
    await expect(modal.locator('.modal-error')).toHaveCount(0);
    await expect.poll(async () => (await readGlobal()).theme).toBe('console');
    expect((await readGlobal()).pdf_viewer).toEqual(['zathura']);

    // The batch really cleared, rather than the modal reporting success while
    // still holding an unsaved draft.
    await expect(modal.locator('button.settings-save')).toBeDisabled();
  } finally {
    await booted.cleanup();
  }
});

test('an external write to the very key being staged does not win over the user', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  try {
    const modal = await openSettings(booted);
    await modal.locator('.theme-card[data-theme-id="console"]').click();

    const onDisk = JSON.parse(await readFile(globalPath, 'utf8')) as Record<string, unknown>;
    await writeFile(globalPath, JSON.stringify({ ...onDisk, theme: 'mist' }, null, 2) + '\n', 'utf8');

    await modal.locator('button.settings-save').click();

    // Both sides moved the same leaf. The staged value is the one the user is
    // looking at and just clicked Save on, so it wins — a Save that quietly
    // wrote something other than what the modal shows would be worse than the
    // conflict this replaced.
    await expect
      .poll(async () => JSON.parse(await readFile(globalPath, 'utf8')).theme)
      .toBe('console');
  } finally {
    await booted.cleanup();
  }
});
