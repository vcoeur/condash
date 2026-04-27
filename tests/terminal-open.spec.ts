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

    // The pty may have flushed and exited by the time this CDP roundtrip
    // returns, so prefer the buffered tail (term.attach) over racing
    // term.data. Allow a brief settle for the echo to land in the buffer.
    let attached: { output: string; exited?: number } | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      attached = await booted.window.evaluate(
        (id) => window.condash.termAttach(id),
        session.id,
      );
      if (attached?.output && attached.output.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(attached).not.toBeNull();
    expect(attached!.output).toContain('ready');

    await booted.window.evaluate((id) => window.condash.termClose(id), session.id);
  } finally {
    await booted.cleanup();
  }
});
