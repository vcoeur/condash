import { test, expect, type Page } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read the plain-text content of a live xterm buffer by session id. Works
 *  regardless of whether xterm is using its DOM or canvas/WebGL renderer. */
async function readXtermBuffer(window: Page, sid: string): Promise<string> {
  return window.evaluate((id) => {
    const term = window.__condashXterms?.get(id);
    if (!term) return 'NO-TERM';
    const lines: string[] = [];
    for (let i = 0; i < term.rows; i++) {
      lines.push(term.buffer.active.getLine(i)?.translateToString() ?? '');
    }
    return lines.join('\n');
  }, sid);
}

/** Wait until the given session has a live DOM Terminal (i.e. it is visible). */
async function waitForDomTerm(window: Page, sid: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const present = await window.evaluate(
      (id) => window.__condashXterms?.has(id) ?? false,
      sid,
    );
    if (present) return;
    await wait(50);
  }
  throw new Error(`Timed out waiting for DOM Terminal for ${sid}`);
}

test('hidden terminal tab preserves output and round-trips through the worker', async () => {
  const booted = await bootApp({
    globalConfig: {
      layout: { terminal: true },
    },
  });
  booted.window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  try {
    // Opt into the test-only xterm registry so we can read buffer text without
    // depending on the active renderer.
    await booted.window.evaluate(() => {
      document.body.setAttribute('data-test-xterm-registry', '');
    });

    // Spawn two shells that print unique, stable text and then sleep. The sleep
    // keeps the pty alive so the renderer does not auto-close the tab.
    const a = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "ALFA-1\n"; sleep 30' }),
    );
    const b = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "BRAVO-2\n"; sleep 30' }),
    );

    // Give the renderer time to reconcile both sessions.
    await wait(500);

    // Wait for both shells to register as tabs.
    await booted.window.waitForSelector(`[data-sid="${a.id}"]`, { state: 'attached', timeout: 5000 });
    await booted.window.waitForSelector(`[data-sid="${b.id}"]`, { state: 'attached', timeout: 5000 });

    // Active tab should be 'b' (last spawned). Click 'a' to make it active.
    await booted.window.click(`[data-sid="${a.id}"]`);
    await waitForDomTerm(booted.window, a.id);

    let text = await readXtermBuffer(booted.window, a.id);
    expect(text).toContain('ALFA-1');

    // Switch to tab 'b' — tab 'a' becomes hidden and its parser moves to the
    // worker.
    await booted.window.click(`[data-sid="${b.id}"]`);
    await waitForDomTerm(booted.window, b.id);

    text = await readXtermBuffer(booted.window, b.id);
    expect(text).toContain('BRAVO-2');

    // Switch back to tab 'a'. This hydrates a fresh DOM Terminal from the
    // worker's serialized state.
    await booted.window.click(`[data-sid="${a.id}"]`);
    await waitForDomTerm(booted.window, a.id);

    text = await readXtermBuffer(booted.window, a.id);
    expect(text).toContain('ALFA-1');

    // Close both tabs.
    await booted.window.evaluate((id) => window.condash.termClose(id), a.id);
    await booted.window.evaluate((id) => window.condash.termClose(id), b.id);
  } finally {
    await booted.cleanup();
  }
});
