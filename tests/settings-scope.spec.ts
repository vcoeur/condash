import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp, type BootedApp } from './fixtures/electron-app';

/**
 * Scope-partitioned Settings modal (project 2026-06-27-settings-scope-revamp).
 *
 * The old two-tab + inheritance-badge UI is gone. Every setting now has exactly
 * one home file and the modal renders one scrolling surface, with the rail
 * grouped under two scope headers (Personal · this machine → settings.json;
 * This conception → .condash/settings.json) and each section carrying a scope
 * chip naming its file. This replaces tests/settings-tabs.spec.ts.
 */

/** Open Settings the same way the File menu does — fire the `open-settings`
 *  menu command into the renderer via the channel the production menu uses. */
async function openSettings(booted: BootedApp): Promise<Locator> {
  await booted.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.send('menu-command', 'open-settings');
  });
  const modal = booted.window.locator('.settings-modal');
  await expect(modal).toBeVisible();
  return modal;
}

/** Read + parse a settings file, treating a missing/empty file as `{}`. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

const ALL_SECTIONS = [
  'recents',
  'appearance',
  'terminal',
  'agents',
  'open-with',
  'dashboard',
  'workspace',
  'repositories',
] as const;

test('settings modal: scope-grouped rail, no tabs, scope chips', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({ extraConfig: {} });
  try {
    const modal = await openSettings(booted);

    // The old tab + panel machinery is gone entirely.
    await expect(modal.locator('[role="tablist"]')).toHaveCount(0);
    await expect(modal.locator('[role="tab"]')).toHaveCount(0);
    await expect(modal.locator('#settings-panel-global')).toHaveCount(0);
    await expect(modal.locator('#settings-panel-conception')).toHaveCount(0);
    await expect(modal.locator('.settings-tabpanel')).toHaveCount(0);

    // The rail shows two scope groups with their heads.
    const groups = modal.locator('nav.settings-rail .settings-rail-group');
    await expect(groups).toHaveCount(2);
    await expect(
      modal.locator('.settings-rail-group[data-scope="global"] .settings-rail-group-head'),
    ).toHaveText('Personal · this machine');
    await expect(
      modal.locator('.settings-rail-group[data-scope="conception"] .settings-rail-group-head'),
    ).toHaveText('This conception');

    // Every section renders at once on the single scrolling surface — no
    // section is hidden behind a tab.
    for (const id of ALL_SECTIONS) {
      await expect(modal.locator(`section#settings-section-${id}`)).toHaveCount(1);
    }

    // Each section carries a scope chip; a global-owned one (terminal) is
    // indigo, a conception-owned one (workspace) is green.
    await expect(
      modal.locator('#settings-section-terminal .settings-scope-chip--global'),
    ).toBeVisible();
    await expect(
      modal.locator('#settings-section-workspace .settings-scope-chip--conception'),
    ).toBeVisible();
  } finally {
    await booted.cleanup();
  }
});

test('settings modal: conception + global fields round-trip to their own files', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({ extraConfig: {} });
  const conceptionPath = join(booted.conceptionDir, '.condash', 'settings.json');
  // The fixture isolates the per-machine settings.json under
  // <userDataDir>/condash/ (XDG_CONFIG_HOME → app.getPath('userData')).
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  try {
    const modal = await openSettings(booted);

    // CONCEPTION field — the Workspace path writes .condash/settings.json.
    const workspaceSection = modal.locator('#settings-section-workspace');
    await workspaceSection.scrollIntoViewIfNeeded();
    const workspaceInput = workspaceSection.locator('input[type="text"]').first();
    await workspaceInput.fill('/tmp/scope-workspace');
    await workspaceInput.blur();

    // GLOBAL field — the Dark theme radio writes the per-machine settings.json.
    // Theme is global-only now: there is no per-conception override.
    const darkRadio = modal
      .locator('#settings-section-appearance .settings-radio', { hasText: 'Dark' })
      .locator('input[type="radio"]');
    await darkRadio.check();

    // Nothing reaches disk until Save — one click flushes both drafts, each
    // through its own file's CAS write.
    await modal.locator('button.settings-save').click();

    // The conception file received workspace_path and never the global theme.
    await expect
      .poll(async () => (await readJson(conceptionPath)).workspace_path)
      .toBe('/tmp/scope-workspace');
    expect(Object.prototype.hasOwnProperty.call(await readJson(conceptionPath), 'theme')).toBe(
      false,
    );

    // The global file received the theme and never the conception-scoped
    // workspace_path.
    await expect.poll(async () => (await readJson(globalPath)).theme).toBe('dark');
    expect(Object.prototype.hasOwnProperty.call(await readJson(globalPath), 'workspace_path')).toBe(
      false,
    );
  } finally {
    await booted.cleanup();
  }
});

test('settings modal: a UI-font category applies live and round-trips to settings.json', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({ extraConfig: {} });
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  try {
    const modal = await openSettings(booted);

    // Pick a Monospace family and Bold weight for the Card & list titles
    // category from that category's family/weight <select>s.
    const cardTitleField = modal.locator('#settings-section-appearance .settings-field', {
      hasText: 'Card & list titles',
    });
    await cardTitleField.scrollIntoViewIfNeeded();
    await cardTitleField
      .locator('[aria-label="Card & list titles font family"]')
      .selectOption('mono');
    await cardTitleField.locator('[aria-label="Card & list titles weight"]').selectOption('bold');

    await modal.locator('button.settings-save').click();

    // Round-trips to the per-machine file under uiFonts.cardTitle as a
    // {family, weight} object.
    await expect
      .poll(async () => (await readJson(globalPath)).uiFonts)
      .toEqual({ cardTitle: { family: 'mono', weight: 'bold' } });

    // Applied live: the hook sets the family + weight CSS variables and data
    // attributes on :root (no reload), so card titles restyle immediately. The
    // family variable resolves to the monospace brand base; weight is 700.
    await expect(booted.window.locator(':root')).toHaveAttribute('data-ui-font-card-title', 'mono');
    await expect(booted.window.locator(':root')).toHaveAttribute(
      'data-ui-weight-card-title',
      'bold',
    );
    const [cardTitleFace, monoBase, cardTitleWeight] = await booted.window.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return [
        cs.getPropertyValue('--ui-font-card-title').trim(),
        cs.getPropertyValue('--font-mono-base').trim(),
        cs.getPropertyValue('--ui-weight-card-title').trim(),
      ];
    });
    expect(cardTitleFace).toBe(monoBase);
    expect(cardTitleFace).toContain('monospace');
    expect(cardTitleWeight).toBe('700');
  } finally {
    await booted.cleanup();
  }
});
