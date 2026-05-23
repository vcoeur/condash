import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('terminal pane: New shell spawns an unpinned shell; agents populate the spawn dropdown', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  // Seed one agent so the dropdown has an entry beyond "New shell". We don't
  // *launch* it — its harness binary (opencode) isn't installed on CI, so the
  // pty would exit immediately and the renderer's auto-close would drop the
  // tab. The pinned-tab label invariant rides on agents now (real binaries),
  // which CI can't exercise; the unpinned "New shell" path is checked here.
  const booted = await bootApp({
    prepare: async (dir) => {
      await mkdir(join(dir, 'agents'), { recursive: true });
      await writeFile(
        join(dir, 'agents', 'opencode-demo.json'),
        JSON.stringify({
          harness: 'opencode',
          name: 'opencode-demo',
          slug: 'opencode-demo',
          config: { model: 'deepseek/demo', disableExternalSkills: true },
        }),
        'utf8',
      );
    },
  });
  try {
    const win = booted.window;

    // The renderer must see the seeded agent.
    const agents = await win.evaluate(() => window.condash.listAgents());
    expect(agents.map((a) => a.name)).toContain('opencode-demo');

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
