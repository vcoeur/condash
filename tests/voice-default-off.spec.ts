import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Voice is default-off (Settings → Voice → "Enable voice dictation").
 *
 * The contract pinned here, in three layers:
 * - **No controls, no action.** With voice disabled (the default, and the
 *   state after toggling it off) the Dictate/Read buttons do not render at
 *   all — so nothing can open the microphone, and the IPC gate answers
 *   `disabled` for any stale caller.
 * - **Enable is live.** Ticking the Settings toggle and saving makes the
 *   controls appear without an app restart (the modal live-fires the saved
 *   value into the running UI, the same channel the theme rides).
 * - **Boot honours the file.** A settings.json that already carries
 *   `voice.enabled: true` seeds the controls through the boot bundle.
 *
 * Nothing here clicks Dictate or Read: no microphone prompt, no network, no
 * provider call — only control presence/absence and the settings round-trip.
 */

const DICTATE = '[data-label="dictate"]';
const READ_ALOUD = '[data-label="read-aloud"]';

async function openSettings(booted: Awaited<ReturnType<typeof bootApp>>): Promise<void> {
  await booted.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.send('menu-command', 'open-settings');
  });
  await expect(booted.window.locator('.settings-modal')).toBeVisible();
}

async function spawnShellTab(booted: Awaited<ReturnType<typeof bootApp>>): Promise<void> {
  await booted.window.evaluate(() =>
    window.condash.termSpawn({ side: 'my', command: 'printf "VOICE-TEST\\n"; sleep 30' }),
  );
  // The header actions (Find / Save / voice) live in the column header, which
  // renders with the pane; wait for a control that is always there so the
  // absence assertions below run against a settled header, not a mounting one.
  await expect(booted.window.locator('[data-label="find"]')).toBeVisible();
}

test('voice is inert until enabled in Settings, then live after a save', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({ globalConfig: { layout: { projects: true, terminal: true } } });
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  try {
    await spawnShellTab(booted);

    // Default-off: no voice controls at all.
    await expect(booted.window.locator(DICTATE)).toHaveCount(0);
    await expect(booted.window.locator(READ_ALOUD)).toHaveCount(0);

    // Settings → Voice: the master switch is present and off; the provider
    // fields are hidden behind it (the off state reads as deliberate, not
    // broken — one toggle plus its description, nothing else).
    await openSettings(booted);
    const voice = booted.window.locator('#settings-section-voice');
    await voice.scrollIntoViewIfNeeded();
    const enable = voice.locator('label.settings-checkbox input');
    await expect(enable).toBeVisible();
    await expect(enable).not.toBeChecked();
    await expect(voice.locator('input[type="password"]')).toHaveCount(0);
    await expect(voice.locator('input[type="text"]')).toHaveCount(0);

    // Enabling reveals the provider fields in the draft immediately...
    await enable.check();
    await expect(voice.locator('input[placeholder="sk-or-…"]')).toHaveCount(1);

    // ...and Save makes it true on disk and live in the running UI.
    await booted.window.locator('button.settings-save').click();
    await expect
      .poll(async () => {
        const parsed = JSON.parse(await readFile(globalPath, 'utf8')) as {
          voice?: { enabled?: boolean };
        };
        return parsed.voice?.enabled ?? false;
      })
      .toBe(true);

    await booted.window.keyboard.press('Escape');
    await expect(booted.window.locator('.settings-modal')).toHaveCount(0);
    await expect(booted.window.locator(DICTATE)).toBeVisible();
    await expect(booted.window.locator(READ_ALOUD)).toBeVisible();

    // Disabling again unmounts the controls the same way — the off switch is
    // symmetric, and a mid-flight recording would be cancelled by the same
    // unmount (pinned at the session-controller level; here we pin the UI).
    await openSettings(booted);
    const voiceAgain = booted.window.locator('#settings-section-voice');
    await voiceAgain.scrollIntoViewIfNeeded();
    await voiceAgain.locator('label.settings-checkbox input').uncheck();
    await booted.window.locator('button.settings-save').click();
    await expect
      .poll(async () => {
        const parsed = JSON.parse(await readFile(globalPath, 'utf8')) as {
          voice?: { enabled?: boolean };
        };
        return parsed.voice?.enabled ?? false;
      })
      .toBe(false);

    await booted.window.keyboard.press('Escape');
    await expect(booted.window.locator('.settings-modal')).toHaveCount(0);
    await expect(booted.window.locator(DICTATE)).toHaveCount(0);
    await expect(booted.window.locator(READ_ALOUD)).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('a settings.json that enables voice shows the controls from boot', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({
    globalConfig: {
      layout: { projects: true, terminal: true },
      voice: { enabled: true },
    },
  });
  try {
    await spawnShellTab(booted);
    await expect(booted.window.locator(DICTATE)).toBeVisible();
    await expect(booted.window.locator(READ_ALOUD)).toBeVisible();
  } finally {
    await booted.cleanup();
  }
});
