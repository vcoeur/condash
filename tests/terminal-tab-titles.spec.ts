import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

test('terminal pane: New shell spawns an unpinned shell; agents populate the spawn dropdown', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  // Seed one agent so the dropdown has an entry beyond "New shell". We don't
  // *launch* it — its command (opencode) isn't installed on CI, so the pty
  // would exit immediately and the renderer's auto-close would drop the tab.
  // The pinned-tab label invariant rides on agents now (real commands), which
  // CI can't exercise; the unpinned "New shell" path is checked here.
  const booted = await bootApp({
    extraConfig: {
      agents: [{ id: 'opencode-demo', label: 'opencode-demo', command: 'opencode' }],
    },
  });
  try {
    const win = booted.window;

    // The renderer must see the seeded agent.
    const agents = await win.evaluate(() => window.condash.listAgents());
    expect(agents.map((a) => a.label)).toContain('opencode-demo');

    const dropdown = win.locator('.terminal-tab-dropdown').first();
    await dropdown.click();
    const menu = win.locator('.terminal-tab-dropdown-menu');
    await expect(menu).toBeVisible();
    // The dropdown lists the agent alongside "New shell".
    await expect(menu.locator('li', { hasText: 'opencode-demo' })).toHaveCount(1);

    // New shell spawns one unpinned tab (OSC 7 cwd drives its label, no pin).
    await menu.locator('li', { hasText: 'New shell' }).click();
    const tabs = win.locator('.terminal-tab-label');
    await expect(tabs).toHaveCount(1);

    // Clean up: ask main to kill the session so the test exits cleanly.
    await win.evaluate(async () => {
      const list = await window.condash.termList();
      await Promise.all(list.map((s) => window.condash.termClose(s.id)));
    });
  } finally {
    await booted.cleanup();
  }
});

test('auto-title from .condash/term-titles.json applies to the tab; malformed leaves it', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  const booted = await bootApp({});
  try {
    const win = booted.window;

    // Spawn one plain shell tab (a real shell exists on CI, so it stays open).
    const dropdown = win.locator('.terminal-tab-dropdown').first();
    await dropdown.click();
    const menu = win.locator('.terminal-tab-dropdown-menu');
    await expect(menu).toBeVisible();
    await menu.locator('li', { hasText: 'New shell' }).click();
    await expect(win.locator('.terminal-tab-label')).toHaveCount(1);

    // Discover its session id so we can target it by sid in the watched file.
    const list = await win.evaluate(() => window.condash.termList());
    expect(list.length).toBe(1);
    const sid = list[0].id;

    const titlesPath = join(booted.conceptionDir, '.condash', 'term-titles.json');

    // Write a valid sparse file → the watcher validates + broadcasts; the
    // renderer sparse-merges the title onto the matching tab (autoTitle beats
    // the cwd basename in displayName).
    await writeFile(titlesPath, JSON.stringify({ titles: [{ sid, title: 'auto named tab' }] }), 'utf8');
    await expect(win.locator('.terminal-tab-label', { hasText: 'auto named tab' })).toHaveCount(1, {
      timeout: 15_000,
    });

    // A malformed file must be a no-op — current titles are never wiped.
    await writeFile(titlesPath, '{ not valid json', 'utf8');
    // Give the watcher time to process the change, then assert the title held.
    await win.waitForTimeout(800);
    await expect(win.locator('.terminal-tab-label', { hasText: 'auto named tab' })).toHaveCount(1);

    await win.evaluate(async () => {
      const sessions = await window.condash.termList();
      await Promise.all(sessions.map((s) => window.condash.termClose(s.id)));
    });
  } finally {
    await booted.cleanup();
  }
});
