import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('Run on a configured repo spawns the run: command and emits its output', async () => {
  const booted = await bootApp({
    extraConfig: {
      workspace_path: '/tmp',
      repositories: {
        primary: [{ name: '.', run: 'echo hi-from-runner' }],
      },
    },
  });
  try {
    const session = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'code', repo: '.' }),
    );
    expect(typeof session.id).toBe('string');

    const output = await booted.window.evaluate((id) => {
      return new Promise<string>((resolve) => {
        let acc = '';
        const timeout = setTimeout(() => resolve(acc), 3000);
        const off = window.condash.onTermData((msg) => {
          if (msg.id !== id) return;
          acc += msg.data;
          if (acc.includes('hi-from-runner')) {
            clearTimeout(timeout);
            off();
            resolve(acc);
          }
        });
      });
    }, session.id);
    expect(output).toContain('hi-from-runner');

    await booted.window.evaluate((id) => window.condash.termClose(id), session.id);
  } finally {
    await booted.cleanup();
  }
});
