import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bootApp, sendMenu } from './fixtures/electron-app';

const evidencePath = (testInfo: TestInfo, name: string) =>
  process.env.CONDASH_VOICE_EVIDENCE_DIR
    ? join(process.env.CONDASH_VOICE_EVIDENCE_DIR, name)
    : testInfo.outputPath(name);

async function openVoice(page: Page) {
  await page.locator('.settings-rail-item', { hasText: /^Voice$/ }).click();
  await expect(page.locator('#settings-section-voice')).toBeInViewport();
}

async function captureVoiceDetail(page: Page, testInfo: TestInfo, name: string) {
  const column = await page.locator('.terminal-column').boundingBox();
  const status = await page.locator('[data-test-voice-status]').boundingBox();
  const caption = (await page.locator('.voice-caption').count())
    ? await page.locator('.voice-caption').boundingBox()
    : null;
  expect(column).not.toBeNull();
  expect(status).not.toBeNull();
  const bottom = Math.max(status!.y + status!.height, caption ? caption.y + caption.height : 0);
  await page.screenshot({
    path: evidencePath(testInfo, name),
    clip: { x: column!.x, y: column!.y, width: column!.width, height: bottom - column!.y + 8 },
  });
}

test('grouped Voice keeps ten fields and separates draft routes from real saved key sources', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'condash-clarity-settings-'));
  const envFile = join(directory, 'agents.env');
  await writeFile(envFile, 'MISTRAL_API_KEY=synthetic-env-key\n');
  const booted = await bootApp({
    globalConfig: {
      voice: { enabled: true, sttModel: 'openai/gpt-audio-mini', contextBias: ['ExampleProject'] },
    },
    env: { CONDASH_AGENTS_ENV: envFile },
  });
  const { window: page, app } = booted;
  try {
    await sendMenu(app, 'open-settings');
    await openVoice(page);
    const section = page.locator('#settings-section-voice');
    const vocabulary = section.locator('label', { hasText: 'Context bias — vocabulary' });
    await expect(vocabulary.locator('textarea')).toHaveValue('ExampleProject');
    await expect(vocabulary).toContainText(
      'Sent through OpenRouter provider.options.mistral.context_bias on captions and final.',
    );
    await expect(vocabulary).toContainText(
      'Other upstream providers may ignore these Mistral-specific hints.',
    );
    for (const group of ['Dictation', 'Credentials', 'Read aloud'])
      await expect(section.getByRole('group', { name: group, exact: true })).toHaveCount(1);
    await expect(section.locator('input, textarea')).toHaveCount(10);
    await expect(section.getByText('Enable voice controls (Dictate and Read)')).toBeVisible();
    const keys = section.locator('[data-test-voice-keys]');
    await expect(keys).toContainText(
      'Mistral: Key found in the shared API-key file — not tested with provider',
    );
    await expect(keys).toContainText('OpenRouter: No API key found');
    await expect(section.getByRole('group', { name: 'Credentials', exact: true })).toContainText(
      'Default file: ~/.config/agents/.env (CONDASH_AGENTS_ENV may override it)',
    );
    const original = (await keys.locator('p').allTextContents()).slice(1);
    await section.getByLabel('OpenRouter API key', { exact: true }).fill('synthetic-draft-key');
    await section
      .getByRole('textbox', { name: /^OpenRouter native transcription model/ })
      .fill('draft/audio-chat');
    await expect(section.locator('[data-test-dictation-route]')).toContainText('draft/audio-chat');
    await expect
      .poll(async () => (await keys.locator('p').allTextContents()).slice(1))
      .toEqual(original);
    await expect
      .poll(() =>
        page.evaluate(
          async () => JSON.parse(await window.condash.getGlobalSettingsRaw()).voice.sttModel,
        ),
      )
      .toBe('openai/gpt-audio-mini');
    await section.getByLabel('Periodic captions while recording', { exact: true }).uncheck();
    await expect(section.locator('[data-test-dictation-route]')).toContainText('No live captions');
    await expect(vocabulary).toContainText(
      'The full final audio pass can change segment boundaries and words; accuracy is not guaranteed.',
    );
    await expect(vocabulary).not.toContainText('selects a Stop re-check');
    await expect(vocabulary.locator('textarea')).toHaveValue('ExampleProject');
    await section.getByRole('textbox', { name: /^Speech model/ }).fill('draft/speech');
    await expect(section.locator('[data-test-read-route]')).toContainText('Both use draft/speech');
    await section.getByRole('button', { name: 'Refresh saved key sources' }).click();
    await expect(keys).toContainText('OpenRouter: No API key found');
    await page.locator('.settings-save').click();
    await expect(page.locator('.settings-save')).toBeDisabled();
    await expect(keys).toContainText(
      'OpenRouter: Key entered in Settings — not tested with provider',
    );
    await writeFile(envFile, 'OPENROUTER_API_KEY=synthetic-env-wins\n');
    await page.locator('.settings-rail-item', { hasText: /^Appearance$/ }).click();
    await openVoice(page);
    await expect(keys).toContainText(
      'OpenRouter: Key found in the shared API-key file — not tested with provider',
    );
    await expect(keys).toContainText('Mistral: No API key found');
    await expect(section.getByLabel('OpenRouter API key', { exact: true })).toHaveValue(
      'synthetic-draft-key',
    );
    await expect(
      section.getByRole('textbox', { name: /^OpenRouter native transcription model/ }),
    ).toHaveValue('draft/audio-chat');
    await page.setViewportSize({ width: 1200, height: 1800 });
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: evidencePath(testInfo, 'voice-settings-grouped.png') });
    await section.getByLabel('Periodic captions while recording', { exact: true }).check();
    await expect(section.locator('[data-test-dictation-route]')).toContainText(
      'Periodic captions while recording → OpenRouter (draft/audio-chat)',
    );
    await expect(vocabulary).toContainText('provider.options.mistral.context_bias');
    await expect(vocabulary).not.toContainText('Batch-only dictation uses');
    await section.screenshot({ path: evidencePath(testInfo, 'voice-settings-streaming.png') });
    await section
      .getByRole('group', { name: 'Credentials', exact: true })
      .screenshot({ path: evidencePath(testInfo, 'voice-key-source-detail.png') });
    const status = await page.evaluate(() => window.condash.voiceCredentialStatus());
    expect(JSON.stringify(status)).not.toMatch(/synthetic|\.env|key-|prefix|hash/);

    // Delay actual handler results, rather than replacing status with canned UI data.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as any)._invokeHandlers;
      const original = handlers.get('voiceCredentialStatus');
      const gate = { pending: [] as (() => void)[], fail: false };
      (globalThis as any).voiceKeyGate = gate;
      ipcMain.removeHandler('voiceCredentialStatus');
      ipcMain.handle('voiceCredentialStatus', async (...args) => {
        const result = await original(...args);
        if (gate.fail) throw new Error('Synthetic private path must not be shown');
        await new Promise<void>((resolve) => gate.pending.push(resolve));
        return result;
      });
    });
    await section.getByRole('button', { name: 'Refresh saved key sources' }).click();
    await expect(keys).toContainText('Refreshing');
    await expect(keys).not.toContainText('Key found');
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).voiceKeyGate.pending.length))
      .toBe(1);
    await writeFile(envFile, '');
    await section.getByRole('button', { name: 'Refresh saved key sources' }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).voiceKeyGate.pending.length))
      .toBe(2);
    await app.evaluate(() => (globalThis as any).voiceKeyGate.pending[1]());
    await expect(keys).toContainText('OpenRouter: Key entered in Settings');
    await app.evaluate(() => (globalThis as any).voiceKeyGate.pending[0]());
    await expect(keys).toContainText('OpenRouter: Key entered in Settings');
    await expect(keys).not.toContainText('shared API-key file');
    await app.evaluate(() => {
      (globalThis as any).voiceKeyGate.fail = true;
    });
    await section.getByRole('button', { name: 'Refresh saved key sources' }).click();
    await expect(keys).toContainText('Refresh failed — key sources not checked');
    await expect(keys).not.toContainText('Key entered');
    await expect(keys).not.toContainText('private path');
  } finally {
    await booted.cleanup();
  }
});

test('native OpenRouter captions precede Stop; final, failure, cancellation and model ownership stay explicit', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'condash-clarity-action-'));
  const envFile = join(directory, 'agents.env');
  const bundle = join(directory, 'voice.cjs');
  await writeFile(
    envFile,
    'MISTRAL_API_KEY=synthetic-mistral\nOPENROUTER_API_KEY=synthetic-openrouter\n',
  );
  await build({
    entryPoints: [resolve('tests/fixtures/voice-clarity.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    plugins: [
      {
        name: 'voice-edges',
        setup(build) {
          build.onResolve({ filter: /^\.\.\/terminals$/ }, () => ({
            path: resolve('tests/fixtures/voice-clarity-edges.ts'),
          }));
        },
      },
    ],
  });
  const booted = await bootApp({
    globalConfig: {
      layout: { projects: true, terminal: true },
      voice: {
        enabled: true,
        sttModel: 'mistralai/voxtral-mini-transcribe',
        contextBias: ['ExampleProject'],
      },
    },
    env: {
      CONDASH_AGENTS_ENV: envFile,
      PULSE_SERVER: 'unix:/tmp/condash-clarity-no-pulse',
      PIPEWIRE_REMOTE: 'condash-clarity-no-pipewire',
    },
    electronArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const { app, window: page } = booted;
  const state = () =>
    app.evaluate((_electron, path) => {
      const harness = process.getBuiltinModule('module').createRequire(path)(path);
      return harness.fixture;
    }, bundle);
  const mode = (value: string) =>
    app.evaluate(
      (_electron, { path, value }) => {
        const harness = process.getBuiltinModule('module').createRequire(path)(path);
        harness.fixture.mode = value;
        harness.fixture.finalizing = false;
      },
      { path: bundle, value },
    );
  try {
    const devices = await page.evaluate(async () =>
      (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput')
        .map((device) => device.label),
    );
    expect(devices).toContain('Fake Default Audio Input');
    expect(
      devices.every((label) => /^Fake (Default Audio Input|Audio Input \d+)$/.test(label)),
    ).toBe(true);
    // Browser-only capture override: exercise a real non-16-kHz synthetic graph,
    // without editing application config or making native devices available.
    await page.evaluate(() => {
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor() {
          super({ sampleRate: 48000 });
        }
      };
    });
    const session = await page.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'sleep 600' }),
    );
    await app.evaluate(
      (_electron, { path, sid }) => {
        const harness = process.getBuiltinModule('module').createRequire(path)(path);
        harness.fixture.sid = sid;
        harness.install();
      },
      { path: bundle, sid: session.id },
    );
    const dictate = page.locator('[data-label="dictate"]');
    const report = page.locator('[data-test-voice-status]');
    await dictate.click();
    await expect(page.locator('.voice-caption-text')).toHaveText('Synthetic live caption');
    await expect(report).toContainText(
      'Recording — periodic OpenRouter captions are provisional; final text follows Stop.',
    );
    await captureVoiceDetail(page, testInfo, 'voice-live-recording-detail.png');
    expect((await state()).writes).toHaveLength(0);
    await page.evaluate(async () => {
      const saved = await window.condash.getGlobalSettingsRaw();
      const next = JSON.parse(saved);
      next.voice.sttModel = 'old/saved-chat-id';
      next.voice.contextBias = ['ChangedAfterStart'];
      await window.condash.writeGlobalSettings(saved, JSON.stringify(next));
    });
    await dictate.click();
    await expect(report).toContainText(
      'Text inserted into the tab. Periodic captions were shown; OpenRouter native STT transcribed the full final recording.',
    );
    expect((await state()).writes).toEqual([
      { sid: session.id, text: 'Synthetic corrected final' },
    ]);
    const firstRequests = (await state()).requests;
    expect(firstRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of firstRequests) {
      expect(request.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
      expect(request.model).toBe('mistralai/voxtral-mini-transcribe');
      expect(request.hints).toContain('ExampleProject');
      expect(request.rate).toBe(48000);
    }
    await captureVoiceDetail(page, testInfo, 'voice-final-result-detail.png');
    await captureVoiceDetail(page, testInfo, 'voice-live-batch-final.png');
    await page.evaluate(async () => {
      const saved = await window.condash.getGlobalSettingsRaw();
      const next = JSON.parse(saved);
      next.voice.sttModel = 'mistralai/voxtral-mini-transcribe';
      await window.condash.writeGlobalSettings(saved, JSON.stringify(next));
    });

    await writeFile(envFile, 'MISTRAL_API_KEY=synthetic-read-aloud-only\n');
    await mode('live');
    await dictate.click();
    await expect(report).toContainText(
      'Recording — recording continues; transcription follows Stop.',
    );
    await expect(page.locator('.toast')).toContainText(
      'recording continues for transcription after Stop',
    );
    await page.waitForTimeout(500); // Capture a non-empty synthetic buffered clip without a stream tap.
    await page
      .locator('.terminal-column')
      .screenshot({ path: evidencePath(testInfo, 'voice-unavailable-recording.png') });
    const beforeMissingKey = (await state()).requests.length;
    await dictate.click();
    await expect(report).toContainText('OpenRouter API key required for dictation');
    expect((await state()).writes).toHaveLength(1);
    expect((await state()).requests).toHaveLength(beforeMissingKey);

    await writeFile(
      envFile,
      'MISTRAL_API_KEY=synthetic-mistral\nOPENROUTER_API_KEY=synthetic-openrouter\n',
    );
    await mode('unknown');
    await dictate.click();
    await expect(page.locator('.voice-caption-text')).toHaveText('Synthetic live caption');
    await dictate.click();
    await expect(report).toContainText('Insertion unconfirmed.');
    await expect(report).toContainText('The final transcript source is unknown.');
    expect((await state()).writes).toHaveLength(2); // Main inserted before the reply was lost.
    await page
      .locator('.terminal-column')
      .screenshot({ path: evidencePath(testInfo, 'voice-unknown-insertion.png') });

    await writeFile(envFile, 'OPENROUTER_API_KEY=synthetic-openrouter\n');
    await mode('failed');
    await dictate.click();
    await expect(report).toContainText('Live captions were unavailable;');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-label="dictate"]')?.getAttribute('aria-pressed') === 'true',
    );
    await dictate.click();
    await expect(report).toContainText('Nothing inserted.');
    await expect(report).toContainText('Synthetic provider failure');
    expect((await state()).writes).toHaveLength(2);
    await page
      .locator('.terminal-column')
      .screenshot({ path: evidencePath(testInfo, 'voice-failed-final.png') });

    await mode('hold');
    const beforeCancel = (await state()).requests.length;
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.down('Space');
    await expect.poll(async () => (await state()).requests.length).toBe(beforeCancel + 1);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('.voice-caption-text')).toHaveCount(0);
    await expect.poll(async () => (await state()).requests.at(-1)?.aborted).toBe(true);
    await app.evaluate((_electron, path) => {
      const harness = process.getBuiltinModule('module').createRequire(path)(path);
      for (const release of harness.fixture.releases.splice(0)) release();
    }, bundle);
    await page.keyboard.up('Space');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await expect(report).toContainText('Recording cancelled. Nothing inserted.');
    expect((await state()).writes).toHaveLength(2);
    expect((await state()).requests).toHaveLength(beforeCancel + 1);
    await expect(page.locator('.voice-caption-text')).toHaveCount(0);

    await mode('live');
    await page.evaluate(async () => {
      const saved = await window.condash.getGlobalSettingsRaw();
      const next = JSON.parse(saved);
      next.voice.sttModel = 'old/saved-chat-id';
      await window.condash.writeGlobalSettings(saved, JSON.stringify(next));
    });
    const selected = await page.evaluate(async (sid) => {
      await window.condash.voiceStreamStart({
        ownerId: 'exact-existing-model',
        sid,
        sampleRate: 48000,
      });
      await window.condash.voiceStreamAudio({ ownerId: 'exact-existing-model', pcmBase64: 'AAA=' });
      return window.condash.voiceStreamStop('exact-existing-model');
    }, session.id);
    expect(selected.inserted).toBe(true);
    expect((await state()).requests.at(-1)?.model).toBe('old/saved-chat-id');
    await page.evaluate(async () => {
      const saved = await window.condash.getGlobalSettingsRaw();
      const next = JSON.parse(saved);
      next.voice.enabled = false;
      await window.condash.writeGlobalSettings(saved, JSON.stringify(next));
    });
    const beforeDisabled = (await state()).requests.length;
    expect(
      await page.evaluate(
        (sid) => window.condash.voiceStreamStart({ ownerId: 'disabled', sid, sampleRate: 48000 }),
        session.id,
      ),
    ).toEqual({ ok: false, reason: 'disabled' });
    expect((await state()).requests).toHaveLength(beforeDisabled);
  } finally {
    await booted.cleanup();
  }
});
