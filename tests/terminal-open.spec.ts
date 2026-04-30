import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('terminal pane opens and a My-terms shell tab spawns a session', async () => {
  const booted = await bootApp();
  try {
    // Use a long-running command so the pty stays alive until we explicitly
    // termClose at the end. A bare `echo` exits immediately, which races
    // with the renderer's auto-close-on-exit in the bottom-pane TerminalPane —
    // when the renderer wins, `attachTerminal` returns null because the
    // session has already been deleted in main.
    const session = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf ready; sleep 5' }),
    );
    expect(typeof session.id).toBe('string');
    expect(session.id.length).toBeGreaterThan(0);

    // Buffered tail (term.attach) over racing term.data — `printf` flushes
    // synchronously but the CDP roundtrip can still beat the pty's first
    // write, so we poll briefly.
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
