import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('terminal pane opens and a My-terms shell tab spawns a session', async () => {
  const booted = await bootApp();
  try {
    // Spawn a session via IPC and assert the session id comes back.
    const session = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'echo ready' }),
    );
    expect(typeof session.id).toBe('string');
    expect(session.id.length).toBeGreaterThan(0);

    // Wait for the prompt or the echo to come back via the data channel.
    const sawData = await booted.window.evaluate((id) => {
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 2000);
        const off = window.condash.onTermData((msg) => {
          if (msg.id !== id) return;
          if (msg.data.length > 0) {
            clearTimeout(timeout);
            off();
            resolve(true);
          }
        });
      });
    }, session.id);
    expect(sawData).toBe(true);

    await booted.window.evaluate((id) => window.condash.termClose(id), session.id);
  } finally {
    await booted.cleanup();
  }
});
