import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

test('built opt-in dashboard shares full-job slots, coalesces Update and fences closed phases', async () => {
  test.setTimeout(90_000);
  const booted = await bootApp({
    globalConfig: {
      dashboard: {
        enabled: true,
        apiKey: 'fixture-only',
        baseUrl: 'https://dashboard-fixture.invalid',
        model: 'fixture-card',
        writerModel: 'fixture-writer',
        intervalSec: 300,
      },
      terminal: { memory: { enabled: false, appScope: { enabled: false } } },
      autoSync: { enabled: false },
      layout: { projects: true, working: 'code', terminal: true },
    },
    beforeFirstWindow: async (app) => {
      await app.evaluate(() => {
        const probe = {
          calls: [] as { phase: string; tab: number }[],
          held: [] as { phase: string; tab: number; release(): void }[],
          pending: 0,
          peak: 0,
        };
        (globalThis as any).__dashboardProbe = probe;
        globalThis.fetch = (async (url: string, options: any) => {
          if (url !== 'https://dashboard-fixture.invalid/chat/completions') {
            throw new Error('external fetch blocked by dashboard fixture');
          }
          const body = JSON.parse(options.body);
          const phase = body.model === 'fixture-card' ? 'card' : 'writer';
          const input = body.messages[1].content;
          const match =
            phase === 'card'
              ? input.match(/fixture output (\d+)/)
              : input.match(/Draft title.*: fixture (\d+)/);
          if (!match) throw new Error('unexpected fixture prompt');
          const tab = Number(match[1]);
          probe.calls.push({ phase, tab });
          probe.peak = Math.max(probe.peak, ++probe.pending);
          await new Promise<void>((release) => {
            probe.held.push({ phase, tab, release });
          });
          probe.pending--;
          const content =
            phase === 'card'
              ? {
                  title: `fixture ${tab}`,
                  currentAction: `fixture action ${tab}`,
                  contextLines: [],
                  state: 'working',
                  activity: 'testing',
                }
              : {
                  title: `Built bounded fixture ${tab}`,
                  subtitle: `Locally mocked work ${tab}`,
                };
          return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
          };
        }) as typeof fetch;
      });
    },
  });
  const calls = () => booted.app.evaluate(() => (globalThis as any).__dashboardProbe.calls);
  const release = (phase: string, tab: number) =>
    booted.app.evaluate(
      (_electron, { phase, tab }) => {
        const held = (globalThis as any).__dashboardProbe.held;
        const at = held.findIndex((entry: any) => entry.phase === phase && entry.tab === tab);
        if (at < 0) throw new Error('fixture phase not pending');
        held.splice(at, 1)[0].release();
      },
      { phase, tab },
    );
  try {
    const sids: string[] = [];
    for (let i = 0; i < 4; i++)
      sids.push(
        await booted.window.evaluate(
          async (index) =>
            (
              await window.condash.termSpawn({
                side: 'my',
                command: `printf 'fixture output ${index}\\n'; sleep 90`,
              })
            ).id,
          i,
        ),
      );
    await booted.window.locator('.terminal-tab-dashboard').click();
    await expect.poll(calls, { timeout: 45_000 }).toEqual([
      { phase: 'card', tab: 0 },
      { phase: 'card', tab: 1 },
      { phase: 'card', tab: 2 },
    ]);
    await booted.window.evaluate((ids) => {
      (window as any).__dashboardSettled = 0;
      for (const sid of [ids[0], ids[3], ids[3]]) {
        void window.condash.dashboardRefreshTab(sid).then(() => {
          (window as any).__dashboardSettled++;
        });
      }
    }, sids);
    await release('card', 0);
    await expect.poll(calls).toEqual([
      { phase: 'card', tab: 0 },
      { phase: 'card', tab: 1 },
      { phase: 'card', tab: 2 },
      { phase: 'writer', tab: 0 },
    ]);
    expect(await booted.window.evaluate(() => (window as any).__dashboardSettled)).toBe(0);
    await booted.window.evaluate((sid) => window.condash.termClose(sid), sids[1]);
    await release('card', 1);
    await expect.poll(calls).toEqual([
      { phase: 'card', tab: 0 },
      { phase: 'card', tab: 1 },
      { phase: 'card', tab: 2 },
      { phase: 'writer', tab: 0 },
      { phase: 'card', tab: 3 },
    ]);
    await expect
      .poll(() =>
        booted.window.evaluate(
          async () => (await window.condash.dashboardGetState())?.summarizingSids?.length,
        ),
      )
      .toBe(3);
    await release('writer', 0);
    await expect
      .poll(() => booted.window.evaluate(() => (window as any).__dashboardSettled))
      .toBe(1);
    await release('card', 2);
    await release('card', 3);
    await expect
      .poll(async () => (await calls()).filter((call: any) => call.phase === 'writer').length)
      .toBe(3);
    await release('writer', 3);
    await expect
      .poll(() => booted.window.evaluate(() => (window as any).__dashboardSettled))
      .toBe(3);
    const pane = booted.window.locator('.dashboard-pane');
    await expect(
      pane.locator('.dashboard-card-title', { hasText: 'Built bounded fixture 3' }),
    ).toBeVisible();
    const outDir = test.info().outputPath();
    await mkdir(outDir, { recursive: true });
    await booted.window.screenshot({ path: join(outDir, 'dashboard-bounds-held.png') });
    console.log(
      'dashboard-bounds held resource sample',
      await booted.app.evaluate(({ app }) => ({
        mainHeapBytes: process.memoryUsage().heapUsed,
        mainRssBytes: process.memoryUsage().rss,
        processes: app.getAppMetrics().map((metric) => ({
          type: metric.type,
          workingSetKiB: metric.memory.workingSetSize,
          cpuPercent: metric.cpu.percentCPUUsage,
        })),
      })),
    );
    await release('writer', 2);
    await expect
      .poll(() =>
        booted.window.evaluate(
          async () => (await window.condash.dashboardGetState())?.summarizingSids ?? [],
        ),
      )
      .toEqual([]);
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(join(booted.conceptionDir, '.condash/dashboard/state.json'), 'utf8'),
        );
        return saved.tabs.map((tab: any) => tab.sid).sort();
      })
      .toEqual([sids[0], sids[2], sids[3]].sort());
    expect(await calls()).toEqual([
      { phase: 'card', tab: 0 },
      { phase: 'card', tab: 1 },
      { phase: 'card', tab: 2 },
      { phase: 'writer', tab: 0 },
      { phase: 'card', tab: 3 },
      { phase: 'writer', tab: 2 },
      { phase: 'writer', tab: 3 },
    ]);
    expect(
      await booted.app.evaluate(() => ({
        peak: (globalThis as any).__dashboardProbe.peak,
        pending: (globalThis as any).__dashboardProbe.pending,
      })),
    ).toEqual({ peak: 3, pending: 0 });
    await booted.window.screenshot({ path: join(outDir, 'dashboard-bounds-settled.png') });
    console.log(
      'dashboard-bounds settled resource sample',
      await booted.app.evaluate(({ app }) => ({
        mainHeapBytes: process.memoryUsage().heapUsed,
        mainRssBytes: process.memoryUsage().rss,
        processes: app.getAppMetrics().map((metric) => ({
          type: metric.type,
          workingSetKiB: metric.memory.workingSetSize,
          cpuPercent: metric.cpu.percentCPUUsage,
        })),
      })),
    );
  } finally {
    await booted.app
      .evaluate(() => {
        for (const entry of (globalThis as any).__dashboardProbe.held.splice(0)) entry.release();
      })
      .catch(() => {});
    await booted.cleanup();
  }
});

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
    // than the old status/overview strip. The power dot renders as soon as the
    // config view resolves (it does not wait for the engine's first roster
    // tick), so wait on the product-exposed condition — the dot carrying any
    // valid data-power value — with headroom, then pin the no-key state we
    // seeded. (Per release.md: a spec waits on a condition the product exposes,
    // never on a duration.)
    await expect(pane.locator('.dashboard-topline-power[data-power]')).toBeVisible({
      timeout: 30_000,
    });
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
    await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'sleep 60' }),
    );
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
