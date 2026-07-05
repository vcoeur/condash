import { test, expect, type Page } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read the plain-text content of a live xterm buffer by session id, scrollback
 *  included (see terminal-hidden-tab.spec.ts). */
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
    const present = await window.evaluate((id) => window.__condashXterms?.has(id) ?? false, sid);
    if (present) return;
    await wait(50);
  }
  throw new Error(`Timed out waiting for DOM Terminal for ${sid}`);
}

async function rowsOf(window: Page, sid: string): Promise<number> {
  return window.evaluate((id) => window.__condashXterms?.get(id)?.rows ?? -1, sid);
}

// The Refresh action nudges the pty one row shorter and back (SIGWINCH) so the
// running program repaints its whole screen — the escape hatch for a stale
// half-frame left by the hidden-tab serialize/hydrate round-trip. The nudge must
// be transparent for a plain shell: the terminal ends at its original size and
// its output is neither lost nor duplicated (scrollback is kept).
test('Refresh repaints the active terminal, restoring its size and keeping its buffer', async () => {
  const booted = await bootApp({
    globalConfig: {
      layout: { terminal: true },
    },
  });
  booted.window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  try {
    await booted.window.evaluate(() => {
      document.body.setAttribute('data-test-xterm-registry', '');
    });

    // A shell that prints one stable marker then sleeps so the tab stays open.
    const term = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "REFRESH-ME\n"; sleep 30' }),
    );

    await wait(500);
    await booted.window.waitForSelector(`[data-sid="${term.id}"]`, {
      state: 'attached',
      timeout: 5000,
    });
    await waitForDomTerm(booted.window, term.id);

    // Wait for the marker to land in the (single, active) tab's buffer.
    let text = '';
    const start = Date.now();
    while (Date.now() - start < 5000) {
      text = await readXtermBuffer(booted.window, term.id);
      if (countOccurrences(text, 'REFRESH-ME') >= 1) break;
      await wait(50);
    }
    expect(countOccurrences(text, 'REFRESH-ME'), 'marker before refresh').toBe(1);

    const rowsBefore = await rowsOf(booted.window, term.id);
    expect(rowsBefore, 'terminal has a real row count').toBeGreaterThan(1);

    // Trigger the Refresh strip button and let the down-then-restore nudge settle
    // (well past REPAINT_NUDGE_MS = 80ms).
    await booted.window.click('[data-label="refresh"]');
    await wait(400);

    // The terminal is back at its original size, still live, and the marker is
    // present exactly once — the resize round-trip neither dropped nor duplicated
    // buffered output.
    await waitForDomTerm(booted.window, term.id);
    expect(await rowsOf(booted.window, term.id), 'rows restored after refresh').toBe(rowsBefore);
    const textAfter = await readXtermBuffer(booted.window, term.id);
    expect(countOccurrences(textAfter, 'REFRESH-ME'), 'marker after refresh').toBe(1);

    await booted.window.evaluate((id) => window.condash.termClose(id), term.id);
  } finally {
    await booted.cleanup();
  }
});
