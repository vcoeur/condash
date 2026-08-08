import { test, expect } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * First-run onboarding surfaces (project: condash first-run onboarding fixes,
 * audit D2 / D6 / D7):
 *
 * 1. The folder-picker empty state glosses "conception".
 * 2. The Code pane (the default working surface) shows a real empty state
 *    with a CTA that opens Settings on the Repositories section when no
 *    repos are configured.
 * 3. A template-initiated tree meets the Welcome screen once — immediately
 *    after init and on the next launch — but not on later launches.
 */
test('empty state: folder picker glosses "conception"', async () => {
  // No lastConceptionPath → the app boots onto the folder-picker empty state.
  const booted = await bootApp({ globalConfig: { lastConceptionPath: undefined } });
  try {
    const empty = booted.window.locator('.workspace-center .empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('Pick a conception directory to list its projects.');
    await expect(empty).toContainText(
      'A conception is a folder of Markdown projects and knowledge notes',
    );
  } finally {
    await booted.cleanup();
  }
});

test('code pane: empty state with a CTA into Settings → Repositories', async () => {
  const booted = await bootApp();
  try {
    const { window } = booted;
    // Code is the default working surface; make sure it is the selected one.
    const codeRail = window.locator('.rail-item[title*="Code"]');
    await expect(codeRail).toBeVisible();
    if ((await codeRail.getAttribute('aria-pressed')) !== 'true') {
      await codeRail.click();
    }

    const empty = window.locator('.pane-working .pane-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No repositories configured yet.');
    await expect(empty).toContainText('.condash/settings.json');

    // The CTA opens Settings and lands on the Repositories section. The
    // section is the last one on the rail, so the landing scrolls the
    // container to its bottom where the section is fully visible.
    await empty.getByRole('button', { name: '+ Add repository' }).click();
    const modal = window.locator('.settings-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#settings-section-repositories')).toBeInViewport();
  } finally {
    await booted.cleanup();
  }
});

test('welcome: template init shows the welcome once (one-shot)', async () => {
  const bareDir = await mkdtemp(join(tmpdir(), 'condash-firstrun-'));
  const booted = await bootApp({ globalConfig: { lastConceptionPath: undefined } });
  try {
    const { window, app, userDataDir } = booted;

    // Make the native folder picker return the bare directory.
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
    }, bareDir);

    // Pick the folder → init prompt fires (probe runs on pick).
    await window.getByRole('button', { name: 'Choose folder…' }).click();
    const initModal = window.locator('.confirm-modal', {
      hasText: 'Initialise from template?',
    });
    await expect(initModal).toBeVisible();
    await initModal.getByRole('button', { name: 'Initialise' }).click();

    // The seeded tree has knowledge/, so the welcome only appears because of
    // the one-shot post-init marker — this is the D7 assertion.
    await expect(window.locator('.welcome-screen')).toBeVisible({ timeout: 15_000 });
    await expect(window.locator('.welcome-screen')).toContainText('Welcome to condash');

    // The one-shot marker is consumed: the welcome's first render persists
    // welcome.initShown = true to the per-machine settings.
    const settingsPath = join(userDataDir, 'condash', 'settings.json');
    await expect
      .poll(async () => {
        const raw = await readFile(settingsPath, 'utf8').catch(() => '');
        if (!raw) return false;
        const parsed = JSON.parse(raw) as { welcome?: { initShown?: boolean } };
        return parsed.welcome?.initShown === true;
      })
      .toBe(true);

    // Relaunch (renderer reload): the welcome must NOT reappear.
    await window.reload();
    await expect(window.locator('.status-bar')).toBeVisible({ timeout: 15_000 });
    await expect(window.locator('.welcome-screen')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});
