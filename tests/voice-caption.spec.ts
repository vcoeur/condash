import { expect, test, type Locator } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootApp } from './fixtures/electron-app';
import { EVENT_CHANNELS } from '../src/shared/ipc-channels';
import type { VoiceStreamStartRequest } from '../src/shared/types';

type CaptionProbe = {
  request: VoiceStreamStartRequest | null;
  starts: number;
  stops: number;
  batchCalls: number;
};

// Range geometry checks the painted final word, not just its presence in the DOM.
async function geometry(caption: Locator) {
  return caption.evaluate((element) => {
    const text = element.querySelector('.voice-caption-text')! as HTMLElement;
    const node = text.firstChild!;
    const range = document.createRange();
    range.setStart(node, Math.max(0, node.textContent!.length - 8));
    range.setEnd(node, node.textContent!.length);
    const tail = range.getBoundingClientRect();
    const box = text.getBoundingClientRect();
    const strip = element.getBoundingClientRect();
    const column = element.closest('.terminal-column')!.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      lineHeight: Number.parseFloat(getComputedStyle(text).lineHeight),
      scrollTop: text.scrollTop,
      scrollHeight: text.scrollHeight,
      clientHeight: text.clientHeight,
      horizontalOverflow: text.scrollWidth - text.clientWidth,
      stripInsideColumn: strip.left >= column.left && strip.right <= column.right,
      tailVisible:
        tail.width > 0 &&
        tail.height > 0 &&
        tail.top >= box.top - 1 &&
        tail.bottom <= box.bottom + 1 &&
        tail.left >= box.left - 1 &&
        tail.right <= box.right + 1,
    };
  });
}

async function expectTail(caption: Locator, overflowing = true) {
  await expect
    .poll(async () => {
      const measured = await geometry(caption);
      return {
        tailVisible: measured.tailVisible,
        atBottom: measured.scrollHeight - measured.clientHeight - measured.scrollTop <= 1,
        bounded: measured.height <= measured.lineHeight * 3 + 1,
        multiline: measured.height > measured.lineHeight * 1.5,
        overflowsVertically: measured.scrollHeight > measured.clientHeight,
        horizontalOverflow: measured.horizontalOverflow,
        stripInsideColumn: measured.stripInsideColumn,
      };
    })
    .toEqual({
      tailVisible: true,
      atBottom: true,
      bounded: true,
      multiline: true,
      overflowsVertically: overflowing,
      horizontalOverflow: 0,
      stripInsideColumn: true,
    });
}

test('live captions wrap within three rows and follow partials and pane resizes', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const booted = await bootApp({
    globalConfig: {
      layout: { projects: true, terminal: true },
      voice: { enabled: true },
      theme: 'dark',
    },
    env: {
      CONDASH_AGENTS_ENV: join(tmpdir(), 'condash-caption-no-keys.env'),
      PULSE_SERVER: 'unix:/tmp/condash-caption-no-pulse-socket',
      PIPEWIRE_REMOTE: 'condash-caption-no-pipewire-socket',
    },
    electronArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const { app, window } = booted;
  const caption = window.locator('[data-test-voice-caption]');
  const dictate = window.locator('[data-label="dictate"]');
  const observations: Record<string, Awaited<ReturnType<typeof geometry>>> = {};
  const partial = async (text: string) => {
    await app.evaluate(
      ({ BrowserWindow }, { text, channel }) => {
        const probe = (globalThis as unknown as { captionProbe: CaptionProbe }).captionProbe;
        if (!probe.request) throw new Error('No caption stream owner');
        BrowserWindow.getAllWindows()[0].webContents.send(channel, { ...probe.request, text });
      },
      { text, channel: EVENT_CHANNELS.voicePartial },
    );
    await expect(caption.locator('.voice-caption-text')).toHaveText(text);
  };
  try {
    // Reuse the real voice controls/session and fake-device harness; replace only
    // the provider IPC edges, so no microphone or provider outside the fixture is used.
    await app.evaluate(({ ipcMain }) => {
      const probe: CaptionProbe = { request: null, starts: 0, stops: 0, batchCalls: 0 };
      (globalThis as unknown as { captionProbe: CaptionProbe }).captionProbe = probe;
      for (const channel of [
        'voiceStreamStart',
        'voiceStreamAudio',
        'voiceStreamStop',
        'voiceStreamCancel',
        'voiceTranscribe',
      ]) {
        ipcMain.removeHandler(channel);
      }
      ipcMain.handle('voiceStreamStart', (_event, request: VoiceStreamStartRequest) => {
        probe.request = request;
        probe.starts++;
        return { ok: true };
      });
      ipcMain.handle('voiceStreamAudio', () => undefined);
      ipcMain.handle('voiceStreamCancel', () => {
        probe.request = null;
      });
      ipcMain.handle('voiceStreamStop', () => {
        probe.request = null;
        probe.stops++;
        return { inserted: false, reason: 'empty-transcript' };
      });
      ipcMain.handle('voiceTranscribe', () => {
        probe.batchCalls++;
        throw new Error('Unexpected batch transcription');
      });
    });
    const audioInputs = await window.evaluate(async () =>
      (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput')
        .map((device) => device.label),
    );
    expect(audioInputs).toContain('Fake Default Audio Input');
    expect(
      audioInputs.every((label) => /^Fake (Default Audio Input|Audio Input \d+)$/.test(label)),
    ).toBe(true);
    await window.setViewportSize({ width: 900, height: 700 });
    await window.evaluate(() =>
      window.condash.termSpawn({
        side: 'my',
        command: 'printf "Caption fixture ready\\n"; sleep 600',
      }),
    );
    await expect(dictate).toBeVisible();
    await expect(caption).toHaveCount(0);
    await dictate.click();
    await expect(caption).toBeVisible();

    await partial(
      'The live caption grows naturally from a short phrase into multiple visible rows. '.repeat(3),
    );
    await expectTail(caption, false);

    const speech =
      'The live caption keeps the newest spoken words visible while this example sentence grows. '.repeat(
        12,
      ) + 'Current tail visible.';
    await partial(speech);
    observations.initial = await geometry(caption);
    if (process.env.CONDASH_CAPTION_EVIDENCE) {
      await window
        .locator('.terminal-column')
        .screenshot({ path: process.env.CONDASH_CAPTION_EVIDENCE });
    }
    await expectTail(caption);

    // Same-length replacement and incremental append both have to follow the tail.
    await caption.locator('.voice-caption-text').evaluate((element) => (element.scrollTop = 0));
    await partial(speech.replace('Current tail visible.', 'Updated tail visible.'));
    await expectTail(caption);
    await partial(speech + ' The next words arrive as another reactive partial.');
    await expectTail(caption);

    await caption.locator('.voice-caption-text').evaluate((element) => (element.scrollTop = 0));
    await window.setViewportSize({ width: 620, height: 700 });
    await expectTail(caption);
    observations.narrow = await geometry(caption);
    expect(observations.narrow.width).toBeLessThan(observations.initial.width);
    expect(observations.narrow.scrollHeight).toBeGreaterThan(observations.initial.scrollHeight);
    await caption.locator('.voice-caption-text').evaluate((element) => (element.scrollTop = 0));
    await window.setViewportSize({ width: 1300, height: 700 });
    await expectTail(caption);
    observations.wide = await geometry(caption);
    expect(observations.wide.width).toBeGreaterThan(observations.initial.width);
    expect(observations.wide.scrollHeight).toBeLessThan(observations.narrow.scrollHeight);

    await partial('Unbroken'.repeat(160) + 'TAILWORD');
    await expectTail(caption);
    await window.setViewportSize({ width: 620, height: 700 });
    await expectTail(caption);
    observations.unbroken = await geometry(caption);

    // A revised shorter partial resets the scroll position without remounting.
    await partial('Short revised words.');
    await expect.poll(async () => (await geometry(caption)).scrollTop).toBe(0);
    expect((await geometry(caption)).tailVisible).toBe(true);
    expect((await geometry(caption)).height).toBeLessThanOrEqual(
      (await geometry(caption)).lineHeight + 1,
    );
    await dictate.click();
    await expect(caption).toHaveCount(0);
    await expect(dictate).toBeEnabled();
    await dictate.click();
    await expect(caption).toBeVisible();
    await partial('New utterance.');
    expect((await geometry(caption)).tailVisible).toBe(true);
    expect((await geometry(caption)).scrollTop).toBe(0);
    await dictate.click();
    await expect(caption).toHaveCount(0);
    await expect
      .poll(() =>
        app.evaluate(() => {
          const probe = (globalThis as unknown as { captionProbe: CaptionProbe }).captionProbe;
          return { starts: probe.starts, stops: probe.stops, batchCalls: probe.batchCalls };
        }),
      )
      .toEqual({ starts: 2, stops: 2, batchCalls: 0 });
  } finally {
    await testInfo.attach('caption-geometry', {
      body: JSON.stringify(observations, null, 2),
      contentType: 'application/json',
    });
    await booted.cleanup();
  }
});
