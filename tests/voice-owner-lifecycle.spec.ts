import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

test('built Electron exercises pending owner lifecycle with fake media/socket edges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'condash-voice-owner-'));
  const bundle = join(directory, 'lifecycle.cjs');
  await build({
    entryPoints: [resolve('tests/fixtures/voice-owner-lifecycle.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: {
      'solid-js': resolve('node_modules/solid-js/dist/dev.js'),
      '@shared': resolve('src/shared'),
    },
  });
  const booted = await bootApp({ env: { CONDASH_AGENTS_ENV: join(directory, 'no-keys.env') } });
  try {
    const completed = await booted.app.evaluate(async (_electron, path) => {
      const loader = process.getBuiltinModule('module').createRequire(path);
      const harness = loader(path);
      const completed: string[] = [];
      for (const scenario of harness.cancellationAccountingScenarios) {
        await harness.exerciseCancellationAccounting(scenario);
      }
      for (const scenario of harness.lifecycleScenarios) {
        await harness.exerciseVoiceLifecycle(scenario);
        completed.push(scenario);
      }
      return completed;
    }, bundle);
    expect(completed).toHaveLength(21);
    expect(completed.at(-1)).toBe('bounded fail-closed cancellation admission');
  } finally {
    await booted.cleanup();
  }
});
