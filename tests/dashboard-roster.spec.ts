import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Regression for the "Dashboard is blind to active tabs" incident: every open
 * terminal tab must appear in the Dashboard — as a rich summary when one exists,
 * else as a fallback card drawn from its command/cwd — so a tab is never
 * invisible just because it produced no readable output. Here no API key is set,
 * so nothing is summarized; the engine's roster-refresh alone must still surface
 * a card per open tab. Exercises the real engine roster path end to end (no LLM).
 */
test('Dashboard lists every open tab even with no summaries', async () => {
  // The engine refreshes its roster on its first tick (TICK_MS = 15s); we poll
  // for that, so allow generous headroom over the default 30s test timeout.
  test.setTimeout(90_000);
  const booted = await bootApp({
    // Dashboard enabled (roster refresh runs regardless of API key) and the
    // terminal band open so the Dashboard pseudo-tab is reachable.
    globalConfig: {
      dashboard: { enabled: true },
      layout: { projects: true, working: 'code', terminal: true },
    },
  });
  try {
    // Two live tabs the engine should enumerate. `sleep` keeps the pty alive;
    // the command string becomes the tab's `cmd`, shown on the fallback card.
    await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'sleep 60' }),
    );
    await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'sleep 61' }),
    );

    // Activate the Dashboard pseudo-tab (the band is already open).
    const dashTab = booted.window.locator('.terminal-tab-dashboard');
    await dashTab.waitFor({ state: 'visible', timeout: 10_000 });
    await dashTab.click();

    // Wait for the engine's first roster refresh to enumerate both tabs.
    await expect
      .poll(
        async () => {
          const state = await booted.window.evaluate(() => window.condash.dashboardGetState());
          return state?.roster?.length ?? 0;
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBeGreaterThanOrEqual(2);

    // Both tabs render as (fallback) cards — the headline fix: no open tab is
    // invisible, even with nothing summarized. (Direction-B markup: the pending
    // card is `.dashboard-card.dashboard-card-pending` and the title lives in
    // `.dashboard-card-title`.)
    const pane = booted.window.locator('.dashboard-pane');
    await expect(pane.locator('.dashboard-card-title', { hasText: 'sleep 60' })).toBeVisible();
    await expect(pane.locator('.dashboard-card-title', { hasText: 'sleep 61' })).toBeVisible();
    await expect(
      pane
        .locator('.dashboard-card-pending')
        .filter({ hasText: 'Waiting for first agent output' })
        .first(),
    ).toBeVisible();
    expect(await pane.locator('.dashboard-card-pending').count()).toBeGreaterThanOrEqual(2);

    // Liveness without a key (Direction-B): the always-visible top status line
    // must reflect the no-key state — this is the "I see no update / what's going
    // on" fix, now carried by the top-line power dot + the guidance hint rather
    // than the old status/overview strip.
    await expect(pane.locator('.dashboard-topline-power[data-power="nokey"]')).toBeVisible();
    await expect(pane.locator('.dashboard-topline-power[data-power="nokey"]')).toContainText('On');
    // The actionable guidance line is shown (engine can't summarize without a key).
    await expect(
      pane.locator('.dashboard-pane-hint', { hasText: 'No DeepSeek API key' }),
    ).toBeVisible();
    // Pending cards still surface the engine's next-attempt hint in the age slot;
    // with no key the engine is paused, so the hint reads "pending".
    await expect(pane.locator('.dashboard-card-pending .dashboard-card-age').first()).toContainText(
      'pending',
    );

    // Evidence screenshot for the incident record.
    const outDir = resolve(__dirname, 'screenshots-out');
    await mkdir(outDir, { recursive: true });
    await booted.window.setViewportSize({ width: 1280, height: 900 });
    await booted.window.screenshot({ path: join(outDir, 'dashboard-roster.png') }).catch(() => {});
  } finally {
    await booted.cleanup();
  }
});

/**
 * A dashboard card is a link to the terminal tab it summarizes: clicking the
 * card activates that tab and swaps the bottom band from the Dashboard back to
 * the terminal. Two tabs are spawned so the test proves the *right* tab is
 * activated (matched by `data-sid`), not merely "some" tab.
 */
test('Clicking a dashboard card opens that card’s terminal tab', async () => {
  test.setTimeout(90_000);
  const booted = await bootApp({
    globalConfig: {
      dashboard: { enabled: true },
      layout: { projects: true, working: 'code', terminal: true },
    },
  });
  try {
    await booted.window.evaluate(() => window.condash.termSpawn({ side: 'my', command: 'sleep 60' }));
    // Capture the second tab's session id — the card that summarizes it must
    // activate exactly this tab.
    const sid2 = await booted.window.evaluate(
      async () => (await window.condash.termSpawn({ side: 'my', command: 'sleep 61' })).id,
    );

    const dashTab = booted.window.locator('.terminal-tab-dashboard');
    await dashTab.waitFor({ state: 'visible', timeout: 10_000 });
    await dashTab.click();
    await expect(dashTab).toHaveClass(/active/);

    // The second tab's card (its title is the cmd). The roster refresh runs on
    // the engine's first tick, so allow headroom.
    const pane = booted.window.locator('.dashboard-pane');
    const card = pane.locator('.dashboard-card', { hasText: 'sleep 61' });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveAttribute('role', 'button');

    await card.click();

    // The band swaps back to the terminal, and the activated tab is exactly the
    // one the card summarized — never the Dashboard pseudo-tab nor the other tab.
    await expect(booted.window.locator('.terminal-dashboard-band')).toHaveCount(0);
    await expect(dashTab).not.toHaveClass(/active/);
    await expect(booted.window.locator(`.terminal-tab[data-sid="${sid2}"]`)).toHaveClass(/active/);
  } finally {
    await booted.cleanup();
  }
});

/**
 * Regression for #366: the Code-pane Run button spawns a `side: 'code'` session
 * (a long-running dev server). Those are panes, not agent tabs, and must not
 * inflate the "Open tabs · N" count nor render as cards — only the user's
 * `side: 'my'` terminal tabs belong on the dashboard roster.
 */
test('Dashboard roster excludes Code-pane Run (code-side) dev servers', async () => {
  test.setTimeout(90_000);
  const booted = await bootApp({
    globalConfig: {
      dashboard: { enabled: true },
      layout: { projects: true, working: 'code', terminal: true },
    },
  });
  try {
    // One genuine terminal tab (my-side) and one Code-pane Run dev server
    // (code-side). Only the my-side tab is an "open tab" for the dashboard.
    await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'sleep 60' }),
    );
    await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'code', command: 'sleep 62' }),
    );

    const dashTab = booted.window.locator('.terminal-tab-dashboard');
    await dashTab.waitFor({ state: 'visible', timeout: 10_000 });
    await dashTab.click();

    // The roster settles to exactly the one my-side tab — never the code-side
    // dev server — even after both sessions are live.
    await expect
      .poll(
        async () => {
          const state = await booted.window.evaluate(() => window.condash.dashboardGetState());
          return state?.roster?.map((tab) => tab.cmd) ?? [];
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toEqual(['sleep 60']);

    const pane = booted.window.locator('.dashboard-pane');
    await expect(pane.locator('.dashboard-card-title', { hasText: 'sleep 60' })).toBeVisible();
    // The dev server is not rendered as a card…
    await expect(pane.locator('.dashboard-card-title', { hasText: 'sleep 62' })).toHaveCount(0);
    // …and the top-line total-tabs tally counts only the one open terminal tab
    // (the `data-state`-less tally is the running total; Direction-B's replacement
    // for the old "Open tabs · N" header).
    await expect(pane.locator('.dashboard-topline-tally:not([data-state])')).toContainText(
      '1 tabs',
    );

    const outDir = resolve(__dirname, 'screenshots-out');
    await mkdir(outDir, { recursive: true });
    await booted.window.setViewportSize({ width: 1280, height: 900 });
    await booted.window
      .screenshot({ path: join(outDir, 'dashboard-roster-code-excluded.png') })
      .catch(() => {});
  } finally {
    await booted.cleanup();
  }
});
