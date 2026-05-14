import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('terminal pane: + spawns an unpinned shell, λ spawns a pinned launcher tab', async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  // Use `cat` as the launcher command: it's on every PATH and blocks on stdin,
  // so the pty stays alive for the full test (otherwise the renderer's
  // auto-close-on-exit drops the tab before we can read its label). Per the
  // wired-in semantics, the tab label is the launcher command's trimmed
  // first token — so we expect the label "cat".
  const booted = await bootApp({
    extraConfig: {
      terminal: { launchers: [{ symbol: 'lambda', command: 'cat' }] },
    },
  });
  try {
    const win = booted.window;

    // Sanity probe: the renderer must see the λ launcher entry from settings.
    // Schema rename in v2.28.0 — legacy `launcher_command` migrates into this
    // array on load; the unit suite in effective-config.test.ts covers that path.
    const prefs = await win.evaluate(() => window.condash.termGetPrefs());
    expect(prefs.launchers?.[0]?.command).toBe('cat');

    // The terminal pane is mounted but starts collapsed; the column header
    // (with the +/λ buttons) is rendered regardless of `open`. Click each
    // button and assert the resulting tab label.

    // First +: plain shell. We expect the label to be `shell` initially.
    // OSC 7 will eventually arrive from the started shell and rewrite it to
    // the cwd basename — that's the legacy behavior we deliberately keep.
    const plusButton = win.locator('button.terminal-tab-add[title^="New shell tab"]').first();
    await plusButton.click();
    const tabs = win.locator('.terminal-tab-label');
    await expect(tabs).toHaveCount(1);

    // Launcher λ: must show literal "cat" (the launcher_command), and the
    // pin must keep that label even after OSC 7 would otherwise have
    // rewritten it.
    const lambdaButton = win.locator('button.terminal-tab-add.launcher');
    await expect(lambdaButton).toBeVisible();
    await lambdaButton.click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveText('cat');

    // Wait through any OSC 7 the shell might emit (`cat` itself won't, but
    // the wrapper bash -lc could PROMPT_COMMAND on some configs).
    await win.waitForTimeout(500);
    await expect(tabs.nth(1)).toHaveText('cat');

    // Clean up: ask main to kill both sessions so the test exits cleanly.
    await win.evaluate(async () => {
      const list = await window.condash.termList();
      await Promise.all(list.map((s) => window.condash.termClose(s.id)));
    });
  } finally {
    await booted.cleanup();
  }
});
