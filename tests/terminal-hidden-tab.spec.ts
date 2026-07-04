import { test, expect, type Page } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read the plain-text content of a live xterm buffer by session id, scrollback
 *  included. Works regardless of whether xterm is using its DOM or canvas/WebGL
 *  renderer. The full buffer (not just the viewport rows) is read so that a line
 *  duplicated into scrollback by a bad serialize/hydrate round-trip is visible. */
async function readXtermBuffer(window: Page, sid: string): Promise<string> {
  return window.evaluate((id) => {
    const term = window.__condashXterms?.get(id);
    if (!term) return 'NO-TERM';
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString() ?? '');
    }
    return lines.join('\n');
  }, sid);
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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

    // Each tab's marker must appear exactly once and stay that way across
    // repeated hide/show cycles. `toContain` would pass even if the off-thread
    // serialize/hydrate round-trip duplicated scrollback, so assert the exact
    // count instead. Several switches are done so any per-cycle duplication
    // accumulates into an obvious failure.
    const expectMarkerOnce = async (sid: string, marker: string): Promise<void> => {
      await waitForDomTerm(booted.window, sid);
      // Wait for the hydrated buffer to carry the marker (mount + replay + flush
      // are async), then assert it is present exactly once — a duplicate from a
      // bad serialize/hydrate round-trip would read as 2 or more.
      let text = '';
      const start = Date.now();
      while (Date.now() - start < 5000) {
        text = await readXtermBuffer(booted.window, sid);
        if (countOccurrences(text, marker) >= 1) break;
        await wait(50);
      }
      expect(countOccurrences(text, marker), `${marker} occurrences for ${sid}`).toBe(1);
    };

    // Active tab is 'b' (last spawned); tab 'a' is already parsing in the worker.
    for (let cycle = 0; cycle < 3; cycle++) {
      // Show 'a' (hydrated from the worker), then show 'b' (a demotes to the
      // worker, b hydrates from it).
      await booted.window.click(`[data-sid="${a.id}"]`);
      await expectMarkerOnce(a.id, 'ALFA-1');
      await booted.window.click(`[data-sid="${b.id}"]`);
      await expectMarkerOnce(b.id, 'BRAVO-2');
    }

    // Close both tabs.
    await booted.window.evaluate((id) => window.condash.termClose(id), a.id);
    await booted.window.evaluate((id) => window.condash.termClose(id), b.id);
  } finally {
    await booted.cleanup();
  }
});
