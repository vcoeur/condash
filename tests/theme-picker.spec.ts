/**
 * Settings → Appearance theme picker: preview, selection, and keyboard.
 *
 * Runs against the standard fixture conception (not a personal tree), so these
 * assertions execute in every suite run — including the tag-time release run.
 * The visual captures in `ui-revamp-shots.spec.ts` are opt-in and skipped by
 * default; the behavioural contract lives here.
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

test('hovering a card previews it; leaving the grid restores the saved theme', async () => {
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  try {
    const modal = await openSettings(booted);
    expect(await activeTheme(booted)).toEqual({ id: 'light', kind: 'light' });

    await modal.locator('.theme-card[data-theme-id="console"]').hover();
    expect(await activeTheme(booted)).toEqual({ id: 'console', kind: 'dark' });

    // Off the grid entirely — the preview is dropped.
    await modal.locator('.settings-field-label').first().hover();
    expect(await activeTheme(booted)).toEqual({ id: 'light', kind: 'light' });
  } finally {
    await booted.cleanup();
  }
});

test('previewing does not move the checked card or the keyboard tab stop', async () => {
  // Regression guard: routing the preview through the *committed* theme signal
  // made the hovered card render as checked and become the group's only tab
  // stop while nothing was selected.
  //
  // It only reproduces with **no `theme` key on disk**: the modal's
  // `globalTheme()` prefers the parsed file and falls back to the live signal
  // only when the key is absent, so seeding a theme would mask the bug.
  // `undefined` here drops the fixture's default key — JSON.stringify omits it.
  const booted = await bootApp({ globalConfig: { theme: undefined } });
  try {
    const modal = await openSettings(booted);
    const consoleCard = modal.locator('.theme-card[data-theme-id="console"]');
    const systemCard = modal.locator('.theme-card[data-theme-id="system"]');
    await expect(systemCard).toHaveAttribute('aria-checked', 'true');

    await consoleCard.hover();
    // The preview is in force…
    expect((await activeTheme(booted)).id).toBe('console');
    // …but the selection and the tab stop have not moved.
    await expect(consoleCard).toHaveAttribute('aria-checked', 'false');
    await expect(systemCard).toHaveAttribute('aria-checked', 'true');
    await expect(consoleCard).toHaveAttribute('tabindex', '-1');
    await expect(systemCard).toHaveAttribute('tabindex', '0');
  } finally {
    await booted.cleanup();
  }
});

test('a hovered preview is not persisted, and a selection persists on Save', async () => {
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  const readTheme = async (): Promise<unknown> =>
    JSON.parse(await readFile(globalPath, 'utf8')).theme;
  try {
    const modal = await openSettings(booted);
    await modal.locator('.theme-card[data-theme-id="console"]').hover();
    await modal.locator('.settings-field-label').first().hover();
    expect(await readTheme()).toBe('light');

    await modal.locator('.theme-card[data-theme-id="console"]').click();
    // Staged only — nothing reaches disk until Save.
    expect(await readTheme()).toBe('light');

    await modal.locator('button.settings-save').click();
    await expect.poll(readTheme).toBe('console');
    // And the committed theme is in force, with no preview left on top of it.
    expect(await activeTheme(booted)).toEqual({ id: 'console', kind: 'dark' });
  } finally {
    await booted.cleanup();
  }
});

test('arrow keys move focus between cards without staging a change', async () => {
  // Regression guard: auto-selecting on arrow marked the modal dirty just from
  // browsing, arming its unsaved-edits Esc gate.
  const booted = await bootApp({ globalConfig: { theme: 'light' } });
  try {
    const modal = await openSettings(booted);
    const paperCard = modal.locator('.theme-card[data-theme-id="light"]');
    await paperCard.focus();
    await expect(paperCard).toHaveAttribute('aria-checked', 'true');

    await booted.window.keyboard.press('ArrowRight');
    const focused = await booted.window.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.themeId,
    );
    expect(focused).toBe('dark');
    // Focus moved and previews, but the selection is untouched.
    await expect(paperCard).toHaveAttribute('aria-checked', 'true');
    expect(await activeTheme(booted)).toEqual({ id: 'dark', kind: 'dark' });
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
