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
    // invisible, even with nothing summarized.
    const pane = booted.window.locator('.dashboard-pane');
    await expect(pane.locator('.dashboard-tab-card-title', { hasText: 'sleep 60' })).toBeVisible();
    await expect(pane.locator('.dashboard-tab-card-title', { hasText: 'sleep 61' })).toBeVisible();
    await expect(
      pane
        .locator('.dashboard-tab-card-pending')
        .filter({ hasText: 'Waiting for first agent output' })
        .first(),
    ).toBeVisible();
    expect(await pane.locator('.dashboard-tab-card-pending').count()).toBeGreaterThanOrEqual(2);

    // Always-on engine-status strip: even with no key (so nothing is ever
    // summarized) the loop's liveness must be visible — this is the "I see no
    // update / what's going on" fix. With no key the phase is the paused state.
    await expect(pane.locator('.dashboard-status')).toBeVisible();
    await expect(pane.locator('.dashboard-status')).toContainText('Paused');
    // "What's going on" is no longer blank: it narrates the open-but-unsummarized
    // tabs instead of hiding until a summary exists.
    await expect(pane.locator('.dashboard-overview')).toContainText('no transcript captured yet');

    // Evidence screenshot for the incident record.
    const outDir = resolve(__dirname, 'screenshots-out');
    await mkdir(outDir, { recursive: true });
    await booted.window.setViewportSize({ width: 1280, height: 900 });
    await booted.window.screenshot({ path: join(outDir, 'dashboard-roster.png') }).catch(() => {});
  } finally {
    await booted.cleanup();
  }
});
