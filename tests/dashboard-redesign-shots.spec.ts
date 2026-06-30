import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Review screenshots for the Direction-B dashboard redesign. Not a regression
 * guard — it renders the two states a reviewer wants to see (rich populated
 * cards; the empty / no-key pending state) at a fixed 1280x900 and writes the
 * PNGs. Assertions are kept to "the intended markup is on screen" so the shots
 * are never silently blank.
 */

const outDir = resolve(__dirname, 'screenshots-out');

/** Force the bottom terminal band tall and let the dashboard pane grow so a full
 *  row of cards is captured in the element screenshot (the band's default height
 *  would clip the taller cards). Pure presentation — no behaviour change. */
async function enlargeDashboardBand(page: Page): Promise<void> {
  await page
    .addStyleTag({
      content: `
        .terminal-pane { height: 760px !important; }
        .terminal-dashboard-band { overflow: visible !important; }
        .dashboard-pane { height: auto !important; min-height: 700px; overflow: visible !important; }
      `,
    })
    .catch(() => undefined);
}

test('redesign — rich Direction-B cards (injected state)', async () => {
  test.setTimeout(90_000);
  const booted = await bootApp({
    globalConfig: {
      // Enabled but no API key: the engine never summarizes, so it won't
      // overwrite the state we inject (with no key + no live tab the loop goes
      // quiescent after its first tick). The injected snapshot drives the cards.
      dashboard: { enabled: true },
      layout: { projects: true, working: 'code', terminal: true },
    },
  });
  try {
    // Open the Dashboard pane so DashboardView mounts and its onDashboardState
    // subscription is live before we push state into it.
    const dashTab = booted.window.locator('.terminal-tab-dashboard');
    await dashTab.waitFor({ state: 'visible', timeout: 10_000 });
    await dashTab.click();
    await booted.window
      .locator('.dashboard-topline')
      .waitFor({ state: 'visible', timeout: 10_000 });
    // Let onMount's dashboardGetState() resolve (it seeds an empty state) so our
    // pushed snapshot lands last and is not clobbered by that initial read.
    await booted.window.waitForTimeout(400);

    const now = Date.now();
    const richState = {
      updatedAt: now,
      roster: [
        {
          sid: 'rich-1',
          cwd: '/home/alice/src/worktrees/dashboard-redesign/condash',
          repo: 'condash',
          cmd: 'claude',
        },
        {
          sid: 'rich-2',
          cwd: '/home/alice/src/worktrees/opencode-go-providers/quelle',
          repo: 'quelle',
          cmd: 'opencode',
        },
        {
          sid: 'rich-3',
          cwd: '/home/alice/src/vcoeur/conception',
          repo: 'conception',
          cmd: 'claude',
        },
      ],
      tabs: [
        {
          sid: 'rich-1',
          title: 'Wiring dashboard cards',
          subtitle:
            'Rebuilding the Dashboard pane as Direction-B breadcrumb cards with subtitle, activity badge and a recent-actions feed.',
          contextLines: [],
          currentAction: 'Editing dashboard.tsx',
          state: 'working',
          activity: 'implementing',
          app: 'condash',
          worktree: 'dashboard-redesign',
          projects: [
            { slug: '2026-06-30-condash-dashboard-redesign', title: 'Redesign condash dashboard' },
          ],
          updatedAt: now - 8_000,
          events: [
            { at: now - 180_000, text: 'Read dashboard.tsx and the pane CSS' },
            { at: now - 90_000, text: 'Replaced the status strip with a top line' },
            { at: now - 20_000, text: 'Rendering the breadcrumb provenance crumbs' },
          ],
        },
        {
          sid: 'rich-2',
          title: 'Reviewing provider PR',
          subtitle:
            'Reading the OpenAI to Anthropic translation diff and deciding whether the agedum proposal lands this cycle.',
          contextLines: [],
          currentAction: 'Waiting on confirmation',
          state: 'awaiting',
          activity: 'reviewing',
          awaitingPrompt: 'Apply the provider-translation refactor to all three endpoints? (y/n)',
          app: 'quelle',
          worktree: 'opencode-go-providers',
          projects: [{ slug: '2026-06-16-opencode-go-providers', title: 'opencode Go providers' }],
          updatedAt: now - 45_000,
          events: [
            { at: now - 300_000, text: 'Opened the provider translation diff' },
            { at: now - 60_000, text: 'Asked to confirm the three-endpoint refactor' },
          ],
        },
        {
          sid: 'rich-3',
          title: 'Closing project sweep',
          subtitle:
            'Wrote the project close timeline and promoted the durable findings into the knowledge tree.',
          contextLines: [],
          currentAction: 'Idle — finished writing notes',
          state: 'idle',
          activity: 'documenting',
          app: 'conception',
          updatedAt: now - 120_000,
          events: [
            { at: now - 240_000, text: 'Stamped Transferred on two knowledge files' },
            { at: now - 130_000, text: 'Wrote the closing timeline entry' },
          ],
        },
      ],
      history: [],
      engine: { phase: 'no-api-key', nextRunAt: 0, lastRunAt: 0 },
      summarizingSids: [],
    };

    // Push the snapshot over the real engine→renderer channel (the same one the
    // engine uses): EVENT_CHANNELS.dashboardState === 'dashboard-state'.
    await booted.app.evaluate(({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send('dashboard-state', payload);
    }, richState);

    const pane = booted.window.locator('.dashboard-pane');
    // The rich cards rendered (not the pending fallback): three state cards with
    // the redesign's signature parts on screen.
    await expect(pane.locator('.dashboard-card:not(.dashboard-card-pending)')).toHaveCount(3, {
      timeout: 10_000,
    });
    await expect(pane.locator('.dashboard-card[data-state="working"]')).toBeVisible();
    await expect(pane.locator('.dashboard-card[data-state="awaiting"]')).toBeVisible();
    await expect(pane.locator('.dashboard-card-breadcrumb').first()).toBeVisible();
    await expect(pane.locator('.dashboard-card-subtitle').first()).toBeVisible();
    await expect(
      pane.locator('.dashboard-card-activity', { hasText: 'Implementing' }),
    ).toBeVisible();
    await expect(pane.locator('.dashboard-card-awaiting')).toBeVisible();
    await expect(pane.locator('.dashboard-card-crumb', { hasText: '#condash' })).toBeVisible();

    await booted.window.setViewportSize({ width: 1280, height: 900 });
    await enlargeDashboardBand(booted.window);
    await mkdir(outDir, { recursive: true });
    await pane.screenshot({ path: join(outDir, 'dashboard-redesign-rich.png') });
  } finally {
    await booted.cleanup();
  }
});

test('redesign — empty / no-key pending state', async () => {
  test.setTimeout(90_000);
  const booted = await bootApp({
    globalConfig: {
      dashboard: { enabled: true },
      layout: { projects: true, working: 'code', terminal: true },
    },
  });
  try {
    await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'sleep 60' }),
    );
    await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'sleep 61' }),
    );

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

    const pane = booted.window.locator('.dashboard-pane');
    // The no-key state is on screen: the pending cards, the no-key power dot and
    // the guidance hint.
    await expect(pane.locator('.dashboard-card-pending')).toHaveCount(2, { timeout: 10_000 });
    await expect(pane.locator('.dashboard-topline-power[data-power="nokey"]')).toBeVisible();
    await expect(
      pane.locator('.dashboard-pane-hint', { hasText: 'No DeepSeek API key' }),
    ).toBeVisible();

    await booted.window.setViewportSize({ width: 1280, height: 900 });
    await enlargeDashboardBand(booted.window);
    await mkdir(outDir, { recursive: true });
    await pane.screenshot({ path: join(outDir, 'dashboard-redesign-pending.png') });
  } finally {
    await booted.cleanup();
  }
});
