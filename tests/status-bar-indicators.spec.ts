import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';
import { holdFirstCalls } from './fixtures/ipc-hold';

/**
 * The status-bar auto-sync + shipped-skills indicators render live state and
 * their actions. The fixture conception is not a git repo and has no installed
 * skills, so the sync snapshot is empty (commits popover shows its empty state)
 * and the shipped-skills indicator prompts to install.
 */
test('status bar shows live auto-sync + shipped-skills indicators', async () => {
  const booted = await bootApp();
  try {
    const bar = booted.window.locator('.status-bar');

    // Auto-sync pill (a state dot + label) + the "Sync now" action.
    const syncPill = bar.locator('.status-pill').first();
    await expect(syncPill).toBeVisible();
    await expect(syncPill.locator('.status-dot')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Sync now' })).toBeVisible();

    // Shipped-skills indicator: nothing installed in the fixture → prompts to
    // install with a state dot + Install action.
    await expect(bar.getByText('Skills: install')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Install' })).toBeVisible();

    // Clicking the auto-sync pill opens the recent-commits popover. The fixture
    // conception is not a git repo, so the commit list is empty.
    await syncPill.click();
    const popover = booted.window.locator('.status-commits');
    await expect(popover).toBeVisible();
    await expect(popover.getByText('No commits yet.')).toBeVisible();

    // The popover must be portalled OUT of the status bar. The status bar has a
    // `backdrop-filter`, which creates a stacking context that would trap the
    // popover's z-index below the workspace and paint it *behind* the code
    // cards. Portalling to the document body is the fix — assert it escaped.
    expect(await popover.evaluate((el) => el.closest('.status-bar') === null)).toBe(true);
  } finally {
    await booted.cleanup();
  }
});

test('blocked episode remains visible during idle and disabled scheduling', async ({}, testInfo) => {
  const booted = await bootApp();
  try {
    for (const phase of ['idle', 'disabled']) {
      await booted.app.evaluate(({ BrowserWindow }, phase) => {
        BrowserWindow.getAllWindows()[0].webContents.send('auto-sync-status', {
          phase,
          enabled: phase === 'idle',
          intervalMinutes: 10,
          lastRunAt: 1_700_000_000_000,
          nextRunAt: null,
          lastResult: null,
          lastError: null,
          blockedEpisode: { since: 1_700_000_000_000, waitingCommits: null },
        });
      }, phase);
      const pill = booted.window.locator('.status-bar .status-pill').first();
      await expect(pill).toHaveText('Integration needed');
      await expect(pill).toHaveAttribute('title', /unknown waiting commits · first detected/);
    }
    await booted.window
      .locator('.status-bar')
      .screenshot({ path: testInfo.outputPath('blocked-episode-status.png') });
  } finally {
    await booted.cleanup();
  }
});

test('a prior conception\u2019s held snapshot replies never paint after a conception switch', async ({}, testInfo) => {
  const booted = await bootApp();
  try {
    // A second, valid conception to switch to.
    const nextDir = booted.conceptionDir + '-next';
    await mkdir(join(nextDir, 'projects'), { recursive: true });
    await mkdir(join(nextDir, '.condash'), { recursive: true });
    await writeFile(join(nextDir, '.condash', 'settings.json'), '{}\n', 'utf8');

    // Result-derived titles prove both initial snapshot reads have applied;
    // mounted pills alone can still have those reads in flight.
    const bar = booted.window.locator('.status-bar');
    await expect(booted.window.locator('.status-bar-path')).toHaveText(booted.conceptionDir);
    await expect(bar.locator('.status-pill').first()).toHaveAttribute('title', /^0 uncommitted ·/);
    await expect(bar.locator('.status-pill--static')).toHaveAttribute(
      'title',
      'condash skills not installed here',
    );

    const sync = await holdFirstCalls(booted.app, 'syncStatusSnapshot', 2);
    const skills = await holdFirstCalls(booted.app, 'skillsSyncStatus', 1);

    // A push-triggered refresh parks read 1 — it belongs to conception A.
    await booted.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('auto-sync-status', {
        phase: 'idle',
        enabled: true,
        intervalMinutes: 10,
        lastRunAt: 1_700_000_000_000,
        nextRunAt: null,
        lastResult: null,
        lastError: null,
        blockedEpisode: null,
      });
    });
    await expect
      .poll(() => sync.count(), { timeout: 10_000, message: 'conception A sync read is parked' })
      .toBe(1);
    // Pushes refresh sync only; Skills has no held A read after initial settlement.
    expect(await skills.count()).toBe(0);

    // Switch conceptions: sync parks its second call; Skills parks its first.
    await booted.app.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu-open-recent', path);
    }, nextDir);
    await expect(booted.window.locator('.status-bar-path')).toHaveText(nextDir, {
      timeout: 15_000,
    });
    // Path paint does not acknowledge either snapshot IPC's arrival.
    await expect
      .poll(() => sync.count(), { timeout: 10_000, message: 'conception B sync read is parked' })
      .toBe(2);
    await expect
      .poll(() => skills.count(), {
        timeout: 10_000,
        message: 'conception B Skills read is parked',
      })
      .toBe(1);

    // The NEW context's replies resolve first and paint. (The skills owner
    // has one parked call — its pre-switch read resolved before the gate —
    // so the old-context discard it also implements is pinned at unit level
    // in status-bar-ownership.test.ts.)
    await sync.releaseWithValue(1, {
      pendingCount: 3,
      ahead: 0,
      hasUpstream: false,
      recentCommits: [],
    });
    await skills.releaseWithValue(0, {
      installed: true,
      shippedTotal: 4,
      needsInstall: 0,
      edited: 0,
      synced: true,
    });
    await expect(booted.window.locator('.status-bar .status-pill').first()).toHaveText(
      '3 to sync',
      { timeout: 10_000 },
    );
    await expect(
      booted.window.locator('.status-bar').getByText('Skills', { exact: true }),
    ).toBeVisible();

    // The OLD context's held sync reply resolves last — it must not paint.
    await sync.releaseWithValue(0, {
      pendingCount: 0,
      ahead: 0,
      hasUpstream: false,
      recentCommits: [],
    });
    await expect(booted.window.locator('.status-bar .status-pill').first()).toHaveText('3 to sync');
    await expect(
      booted.window.locator('.status-bar').getByText('Skills', { exact: true }),
    ).toBeVisible();
    await expect(booted.window.getByRole('button', { name: 'Install' })).toHaveCount(0);
    await booted.window
      .locator('.status-bar')
      .screenshot({ path: testInfo.outputPath('status-old-root-discarded.png') });
    await sync.uninstall();
    await skills.uninstall();
  } finally {
    await booted.cleanup();
  }
});
