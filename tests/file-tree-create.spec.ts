import { test, expect } from '@playwright/test';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Files-widget inline create regression net (PR #452 / v4.95.0).
 *
 * The preview modal's Files widget grows a footer with "+ New file" /
 * "+ New folder" buttons that open an inline name input (`.file-tree-input`);
 * Enter commits through the createProjectFile/createProjectDir IPC verbs, Esc
 * cancels. A failed create (e.g. the name already exists on disk) shows an
 * inline `.file-tree-error` and RETAINS the typed name so the user can fix it
 * and press Enter again — blur deliberately does not cancel while an error is
 * shown. These specs pin the happy path, the error + retry loop, and the
 * folder variant, asserting both the on-disk result and the refreshed tree.
 */

const sampleDir = (conceptionDir: string): string =>
  join(conceptionDir, 'projects', '2026-04', '2026-04-26-sample');

// `.file-tree-add` matches all three footer buttons; the title attribute is
// the discriminator.
const NEW_FILE_BUTTON = 'button.file-tree-add[title="Create an empty file at the project root"]';
const NEW_FOLDER_BUTTON = 'button.file-tree-add[title="Create a folder at the project root"]';

const fileExists = async (path: string): Promise<boolean> =>
  stat(path)
    .then((s) => s.isFile())
    .catch(() => false);

const dirExists = async (path: string): Promise<boolean> =>
  stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false);

test('New file at the project root writes the file and shows its row', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    await win.waitForSelector('.row', { state: 'visible', timeout: 5000 });
    await win.click('.row .title');
    await win.waitForSelector('.modal.project-preview', { state: 'visible' });

    await win.click(NEW_FILE_BUTTON);
    await win.waitForSelector('.file-tree-input', { state: 'visible' });
    await win.fill('.file-tree-input', 'todo.txt');
    await win.press('.file-tree-input', 'Enter');

    // The durable proof is the empty file on disk; the tree row is the
    // user-visible one (onRefresh refetches the files resource via IPC, so
    // it does not depend on the chokidar watcher).
    await expect
      .poll(() => fileExists(join(sampleDir(booted.conceptionDir), 'todo.txt')))
      .toBe(true);
    await expect(win.locator('.file-tree .file-tree-name', { hasText: 'todo.txt' })).toBeVisible();
    // A successful commit clears the draft input.
    await expect(win.locator('.file-tree-input')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('creating an existing name shows an inline error, keeps the input, and retry succeeds', async () => {
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      // Seed the colliding file before launch (watcher-race-safe).
      await writeFile(join(sampleDir(conceptionDir), 'existing.txt'), 'seeded\n', 'utf8');
    },
  });
  try {
    const win = booted.window;
    await win.waitForSelector('.row', { state: 'visible', timeout: 5000 });
    await win.click('.row .title');
    await win.waitForSelector('.modal.project-preview', { state: 'visible' });

    await win.click(NEW_FILE_BUTTON);
    await win.waitForSelector('.file-tree-input', { state: 'visible' });
    await win.fill('.file-tree-input', 'existing.txt');
    await win.press('.file-tree-input', 'Enter');

    // The create fails EEXIST → inline error, typed name retained for repair.
    await expect(win.locator('.file-tree-error')).toBeVisible();
    await expect(win.locator('.file-tree-error')).toContainText("'existing.txt' already exists");
    await expect(win.locator('.file-tree-input')).toHaveValue('existing.txt');
    // The failed commit's disabled-swap dropped focus; the widget refocuses
    // the input so Enter-to-retry works without a click back in.
    await expect(win.locator('.file-tree-input')).toBeFocused();

    // Blur must NOT cancel while the error is shown (Esc stays the explicit
    // way out) — click a neutral spot and check the draft survived.
    await win.click('.modal.project-preview .widget-title:has-text("Files")');
    await expect(win.locator('.file-tree-input')).toHaveValue('existing.txt');

    // Fix the name and press Enter again: the retry must go through.
    await win.fill('.file-tree-input', 'fresh.txt');
    await win.press('.file-tree-input', 'Enter');
    await expect
      .poll(() => fileExists(join(sampleDir(booted.conceptionDir), 'fresh.txt')))
      .toBe(true);
    await expect(win.locator('.file-tree .file-tree-name', { hasText: 'fresh.txt' })).toBeVisible();
    await expect(win.locator('.file-tree-error')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('New folder at the project root creates the directory', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    await win.waitForSelector('.row', { state: 'visible', timeout: 5000 });
    await win.click('.row .title');
    await win.waitForSelector('.modal.project-preview', { state: 'visible' });

    await win.click(NEW_FOLDER_BUTTON);
    await win.waitForSelector('.file-tree-input', { state: 'visible' });
    await win.fill('.file-tree-input', 'assets');
    await win.press('.file-tree-input', 'Enter');

    await expect.poll(() => dirExists(join(sampleDir(booted.conceptionDir), 'assets'))).toBe(true);
    await expect(
      win.locator('.file-tree-row.file-tree-dir .file-tree-name', { hasText: 'assets' }),
    ).toBeVisible();
  } finally {
    await booted.cleanup();
  }
});
