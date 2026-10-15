import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootApp } from './fixtures/electron-app';

/**
 * Focus preservation and UI surfaces of the terminal voice controls.
 *
 * The defect pinned here: the Dictate/Read buttons live in the column
 * header, and a button click's default pointerdown behaviour moves focus off
 * the xterm textarea — after dictating once, the user's keystrokes went
 * nowhere until they clicked back into the terminal. The fix suppresses the
 * pointerdown default on both voice buttons; the click still fires, the
 * caret stays in the terminal.
 *
 * The microphone is stubbed with Chromium's synthetic device
 * (`--use-fake-device-for-media-stream` + `--use-fake-ui-for-media-stream`):
 * a real MediaStream from a fake source, so the recorder's real graph runs
 * under Xvfb where no mic exists. Key resolution is pointed at a nonexistent
 * env file (`CONDASH_AGENTS_ENV`), so stopping a recording answers a
 * "no API key" error — the whole spec exercises the app with **no network
 * access and no provider call**, which is the E2E line the design draws
 * (full socket round-trips stay unit-level).
 */

/** True when the hidden xterm textarea holds keyboard focus. */
const focusInTerminal = (): boolean => {
  const active = document.activeElement;
  return (
    active instanceof HTMLTextAreaElement &&
    (active.closest('.xterm-host') !== null || active.classList.contains('xterm-helper-textarea'))
  );
};

/**
 * The §10 caption-strip assertions, in the shape this harness can reach.
 * The strip mounts on `partial() !== null`, and a partial only exists once
 * a stream STARTS OK — with no keys reachable, main refuses every start, so
 * a positive mount is not reachable E2E (the mount/unmount signal itself is
 * unit-pinned in voice-session.test.ts). What E2E CAN pin, and what a
 * regression would break: the strip's key is the STREAM, never the bare
 * recording — it must stay absent while a recording is live — and it must
 * leave no stale element after the recording stops.
 */
const expectNoCaptionStrip = (window: import('@playwright/test').Page) =>
  expect(window.locator('[data-test-voice-caption]')).toHaveCount(0);

/** Boot with voice enabled, a fake mic, and no provider keys reachable. */
async function bootVoiceApp() {
  // A path that does not exist: key resolution finds nothing, so a stop can
  // never reach a provider — the error toast at the end proves the flow ran.
  const noKeysEnv = join(tmpdir(), 'condash-voice-focus-no-keys.env');
  const booted = await bootApp({
    globalConfig: { layout: { projects: true, terminal: true }, voice: { enabled: true } },
    env: {
      CONDASH_AGENTS_ENV: noKeysEnv,
      PULSE_SERVER: 'unix:/tmp/condash-voice-focus-no-pulse-socket',
      PIPEWIRE_REMOTE: 'condash-voice-focus-no-pipewire-socket',
    },
    electronArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    const audioInputs = await booted.window.evaluate(async () =>
      (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput')
        .map((device) => device.label),
    );
    expect(audioInputs).toContain('Fake Default Audio Input');
    expect(
      audioInputs.every((label) => /^Fake (Default Audio Input|Audio Input \d+)$/.test(label)),
    ).toBe(true);
    return booted;
  } catch (error) {
    await booted.cleanup();
    throw error;
  }
}

test('clicking Dictate keeps keyboard focus in the terminal', async () => {
  test.setTimeout(90_000);
  const booted = await bootVoiceApp();
  const DICTATE = booted.window.locator('[data-label="dictate"]');
  try {
    await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "VOICE-FOCUS\\n"; sleep 60' }),
    );
    await expect(booted.window.locator('[data-label="find"]')).toBeVisible();
    await expect(DICTATE).toBeVisible();

    // Baseline: the terminal textarea owns focus (click into the terminal).
    await booted.window.locator('.terminal-host').click();
    await expect.poll(() => booted.window.evaluate(focusInTerminal)).toBe(true);

    // Click Dictate: recording starts, and focus must not move.
    await DICTATE.click();
    await expect(DICTATE).toHaveClass(/recording/);
    expect(await booted.window.evaluate(focusInTerminal)).toBe(true);

    // The caption strip is stream-keyed: with no key main refuses the
    // stream start, so no partial exists and the strip must stay absent
    // while the recording is live (see expectNoCaptionStrip above).
    await expectNoCaptionStrip(booted.window);

    // Typed input still lands in the terminal while recording.
    await booted.window.keyboard.type('echo kept-focus');
    await expect.poll(() => booted.window.evaluate(focusInTerminal), { timeout: 5_000 }).toBe(true);
    await expect(DICTATE).toHaveClass(/recording/);

    // Click again to stop: recording ends (the no-key adapter error surfaces
    // as a toast; the assertion below pins the non-network outcome loosely —
    // the exact text belongs to the adapter, not this spec).
    await DICTATE.click();
    await expect(DICTATE).not.toHaveClass(/recording/);
    // ...and no stale caption strip survives the stop.
    await expectNoCaptionStrip(booted.window);
    await expect(booted.window.locator('.toast, [role="alert"]').first()).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await booted.cleanup();
  }
});

test('the push-to-talk chord starts and commits dictation from the keyboard', async () => {
  test.setTimeout(90_000);
  const booted = await bootVoiceApp();
  const DICTATE = booted.window.locator('[data-label="dictate"]');
  try {
    await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "VOICE-PTT\\n"; sleep 60' }),
    );
    await expect(booted.window.locator('[data-label="find"]')).toBeVisible();
    await expect(DICTATE).toBeVisible();
    await booted.window.locator('.terminal-host').click();
    await expect.poll(() => booted.window.evaluate(focusInTerminal)).toBe(true);

    // Hold the default chord (Ctrl+Shift+Space): the keydown of the base key
    // starts the recording — and must NOT type a space into the terminal.
    await booted.window.keyboard.down('Control');
    await booted.window.keyboard.down('Shift');
    await booted.window.keyboard.down('Space');
    await expect(DICTATE).toHaveClass(/recording/);

    // Stream-keyed strip: a held chord starts a recording, not a stream —
    // with no key the start is refused and the strip stays absent.
    await expectNoCaptionStrip(booted.window);

    // Release the base key first (modifiers still held): the chord commits
    // on the base key alone, ignoring modifier order (§7).
    await booted.window.keyboard.up('Space');
    await expect(DICTATE).not.toHaveClass(/recording/);
    await booted.window.keyboard.up('Shift');
    await booted.window.keyboard.up('Control');

    // The commit ran main's stream/batch chain; with no keys it surfaces as
    // the adapter error toast — the no-network outcome this spec pins.
    await expect(booted.window.locator('.toast').first()).toBeVisible({ timeout: 15_000 });
    // No stale caption strip survives the commit.
    await expectNoCaptionStrip(booted.window);
  } finally {
    await booted.cleanup();
  }
});

test('releasing an old held chord cannot stop a new click recording', async () => {
  test.setTimeout(90_000);
  const booted = await bootVoiceApp();
  const DICTATE = booted.window.locator('[data-label="dictate"]');
  try {
    await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "VOICE-LEASE\\n"; sleep 60' }),
    );
    await expect(DICTATE).toBeVisible();
    await booted.window.locator('.terminal-host').click();
    await booted.window.keyboard.down('Control');
    await booted.window.keyboard.down('Shift');
    await booted.window.keyboard.down('Space');
    await expect(DICTATE).toHaveClass(/recording/);

    await DICTATE.click();
    await expect(DICTATE).not.toHaveClass(/recording/);
    await expect(DICTATE).toBeEnabled();
    await DICTATE.click();
    await expect(DICTATE).toHaveClass(/recording/);
    await booted.window.keyboard.down('Space');
    await booted.window.keyboard.up('Shift');
    await booted.window.keyboard.up('Control');
    await booted.window.keyboard.up('Space');
    await expect(DICTATE).toHaveClass(/recording/);
    await expectNoCaptionStrip(booted.window);
    expect(await booted.window.evaluate(focusInTerminal)).toBe(true);

    await DICTATE.click();
    await expect(DICTATE).not.toHaveClass(/recording/);
    await expectNoCaptionStrip(booted.window);
  } finally {
    await booted.cleanup();
  }
});
