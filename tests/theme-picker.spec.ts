/**
 * Settings → Appearance theme picker: selection, preview, and keyboard.
 *
 * Runs against the standard fixture conception (not a personal tree), so these
 * assertions execute in every suite run — including the tag-time release run.
 * The visual captures in `ui-revamp-shots.spec.ts` are opt-in and skipped by
 * default; the behavioural contract lives here.
 *
 * The picker previews the **staged selection**, not whatever the pointer is
 * over. Four attempts at a hover preview each shipped a new stranded-overlay
 * bug, because pointer position and focus position are independent inputs with
 * no correct precedence — see the note on ThemePicker.
 */

import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
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

/** The two attributes `use-theme` stamps on `<html>`. */
async function activeTheme(booted: BootedApp): Promise<{ id?: string; kind?: string }> {
  return booted.window.evaluate(() => ({
    id: document.documentElement.dataset.theme,
    kind: document.documentElement.dataset.themeKind,
  }));
}

test('selecting a card previews it across the app without persisting', async () => {
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  const readTheme = async (): Promise<unknown> =>
    JSON.parse(await readFile(globalPath, 'utf8')).theme;
  try {
    const modal = await openSettings(booted);
    expect(await activeTheme(booted)).toEqual({ id: 'light', kind: 'light' });

    await modal.locator('.theme-card[data-theme-id="console"]').click();
    expect(await activeTheme(booted)).toEqual({ id: 'console', kind: 'dark' });
    expect(await readTheme()).toBe('light');
  } finally {
    await booted.cleanup();
  }
});

test('the preview follows every selection, including after the first one', async () => {
  // Regression guard: with the preview driven by (focus ?? hover), the first
  // click pinned focus on that card and every later hover was outranked, so
  // the picker stopped previewing entirely after one selection.
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  try {
    const modal = await openSettings(booted);
    await modal.locator('.theme-card[data-theme-id="dark"]').click();
    expect((await activeTheme(booted)).id).toBe('dark');

    await modal.locator('.theme-card[data-theme-id="console"]').click();
    expect((await activeTheme(booted)).id).toBe('console');

    await modal.locator('.theme-card[data-theme-id="light"]').click();
    expect((await activeTheme(booted)).id).toBe('light');
  } finally {
    await booted.cleanup();
  }
});

test('the pointer alone never changes the theme', async () => {
  // The whole class of stranded-overlay bugs came from the pointer owning the
  // preview. Hovering must now be inert.
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  try {
    const modal = await openSettings(booted);
    await modal.locator('.theme-card[data-theme-id="console"]').hover();
    expect((await activeTheme(booted)).id).toBe('light');
    // Including the gutter between cards, which fires no card-level event.
    await modal.locator('.theme-picker').hover({ position: { x: 2, y: 2 } });
    expect((await activeTheme(booted)).id).toBe('light');
  } finally {
    await booted.cleanup();
  }
});

test('closing without saving restores the committed theme', async () => {
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  try {
    const modal = await openSettings(booted);
    await modal.locator('.theme-card[data-theme-id="console"]').click();
    expect((await activeTheme(booted)).id).toBe('console');

    // Esc with a staged edit raises the unsaved-edits gate; discard through it.
    await booted.window.keyboard.press('Escape');
    const gate = booted.window.locator('.settings-confirm');
    await expect(gate).toBeVisible();
    await gate.locator('button', { hasText: 'Discard and close' }).click();
    await expect(modal).toBeHidden();
    expect(await activeTheme(booted)).toEqual({ id: 'light', kind: 'light' });
  } finally {
    await booted.cleanup();
  }
});

test('a selection persists on Save and stays in force after the modal closes', async () => {
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  try {
    const modal = await openSettings(booted);
    await modal.locator('.theme-card[data-theme-id="console"]').click();
    await modal.locator('button.settings-save').click();
    await expect
      .poll(async () => JSON.parse(await readFile(globalPath, 'utf8')).theme)
      .toBe('console');

    await booted.window.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    // The overlay dropped on unmount; the committed theme underneath is the one
    // just saved, so nothing visibly changes.
    expect(await activeTheme(booted)).toEqual({ id: 'console', kind: 'dark' });
  } finally {
    await booted.cleanup();
  }
});

test('arrow keys move the selection, the preview, and the tab stop together', async () => {
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  try {
    const modal = await openSettings(booted);
    await modal.locator('.theme-card[data-theme-id="light"]').focus();
    await booted.window.keyboard.press('ArrowRight');

    const warmGallery = modal.locator('.theme-card[data-theme-id="dark"]');
    await expect(warmGallery).toBeFocused();
    await expect(warmGallery).toHaveAttribute('aria-checked', 'true');
    await expect(warmGallery).toHaveAttribute('tabindex', '0');
    await expect(modal.locator('.theme-card[tabindex="0"]')).toHaveCount(1);
    expect((await activeTheme(booted)).id).toBe('dark');
  } finally {
    await booted.cleanup();
  }
});

test('the status-bar cycle persists its choice', async () => {
  // Pre-existing before this branch: the cycle only moved the in-memory signal,
  // so the app came back on the old theme after a restart. It has no modal
  // behind it to do the write.
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  try {
    await booted.window.locator('[aria-label="Cycle theme"]').click();
    // Deterministic: the cycle order is THEME_VALUES, so light → dark. A
    // `.not.toBe('light')` here would also pass on an absent or garbage value.
    await expect
      .poll(async () => JSON.parse(await readFile(globalPath, 'utf8')).theme)
      .toBe('dark');
  } finally {
    await booted.cleanup();
  }
});

test('an unrecognised stored theme still leaves the picker keyboard-reachable', async () => {
  // A hand-edited or newer-build theme id matches no card; without a fallback
  // every card would render tabindex="-1" and the picker would be unreachable
  // by keyboard — exactly the state you need to get to in order to fix it.
  const booted = await bootApp({ globalConfig: { theme: 'solarized' } });
  try {
    const modal = await openSettings(booted);
    const tabStops = modal.locator('.theme-card[tabindex="0"]');
    await expect(tabStops).toHaveCount(1);
    await expect(tabStops).toHaveAttribute('data-theme-id', 'system');
  } finally {
    await booted.cleanup();
  }
});
