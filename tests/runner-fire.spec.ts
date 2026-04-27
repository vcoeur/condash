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

    // `echo` finishes fast and the pty may exit before a renderer-side
    // term.data listener can attach. Poll term.attach (which serves the
    // buffered tail kept in main) until the runner output shows up.
    let output = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      const attached = await booted.window.evaluate(
        (id) => window.condash.termAttach(id),
        session.id,
      );
      output = attached?.output ?? '';
      if (output.includes('hi-from-runner')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(output).toContain('hi-from-runner');

    await booted.window.evaluate((id) => window.condash.termClose(id), session.id);
  } finally {
    await booted.cleanup();
  }
});
