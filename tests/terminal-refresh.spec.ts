import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A stand-in full-screen TUI that runs on the alternate buffer and only repaints
// on a genuine resize (debounced) — see the fixture header. Spawned via node so
// it behaves like opencode for the nudge tests below.
const DEBOUNCE_TUI = resolve(__dirname, 'fixtures', 'alt-screen-debounce-tui.mjs');

/** Highest N across all `TUI-PAINT#N` markers in the session's buffer, or 0. */
async function latestPaintCount(window: Page, sid: string): Promise<number> {
  const text = await readXtermBuffer(window, sid);
  let max = 0;
  for (const m of text.matchAll(/TUI-PAINT#(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** True once the session's live DOM Terminal is on the alternate screen buffer. */
async function isAltBuffer(window: Page, sid: string): Promise<boolean> {
  return window.evaluate(
    (id) => window.__condashXterms?.get(id)?.buffer.active.type === 'alternate',
    sid,
  );
}

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

/** Ordered log of session ids passed to `refreshSession`, or [] if none yet. */
async function refreshLog(window: Page): Promise<string[]> {
  return window.evaluate(() => window.__condashRefreshLog ?? []);
}

// With `terminal.autoRefreshOnTabSwitch` enabled, switching to a tab must run
// the repaint automatically even for a plain shell (the opt-in drops the
// alt-buffer restriction). A shell has nothing to repaint, so rather than look
// for a visual change we assert on `__condashRefreshLog` — the controller's
// record that `refreshSession` actually nudged the newly-active tab. The
// alt-screen tests prove the nudge produces a real repaint.
test('auto-refresh on tab switch repaints the newly-active tab', async () => {
  const booted = await bootApp({
    globalConfig: {
      layout: { terminal: true },
      terminal: { autoRefreshOnTabSwitch: true },
    },
  });
  booted.window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  try {
    await booted.window.evaluate(() => {
      document.body.setAttribute('data-test-xterm-registry', '');
    });

    // Two shells in the (default) left column. The last spawned ('b') is active;
    // 'a' parses in the worker until we switch to it.
    const a = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "ALFA\n"; sleep 30' }),
    );
    const b = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "BRAVO\n"; sleep 30' }),
    );
    await wait(500);
    await booted.window.waitForSelector(`[data-sid="${a.id}"]`, {
      state: 'attached',
      timeout: 5000,
    });
    await booted.window.waitForSelector(`[data-sid="${b.id}"]`, {
      state: 'attached',
      timeout: 5000,
    });
    await waitForDomTerm(booted.window, b.id);

    // Switch to 'a' and wait for its DOM Terminal to hydrate. The switch (b → a)
    // must have appended 'a' to the refresh log — proof the auto-refresh fired
    // on the newly-active tab, not just on the earlier spawns.
    const before = await refreshLog(booted.window);
    await booted.window.click(`[data-sid="${a.id}"]`);
    await waitForDomTerm(booted.window, a.id);

    await expect
      .poll(async () => (await refreshLog(booted.window)).slice(before.length), {
        timeout: 5000,
      })
      .toContain(a.id);

    // The tab is live and its marker survived the auto-refresh exactly once.
    const text = await readXtermBuffer(booted.window, a.id);
    expect(countOccurrences(text, 'ALFA'), 'marker intact after auto-refresh').toBe(1);
    expect(await rowsOf(booted.window, a.id), 'tab live after auto-refresh').toBeGreaterThan(1);

    await booted.window.evaluate((id) => window.condash.termClose(id), a.id);
    await booted.window.evaluate((id) => window.condash.termClose(id), b.id);
  } finally {
    await booted.cleanup();
  }
});

// Regression for the opencode bug: a live full-screen TUI debounces resize
// (~100ms) and only repaints on a real size change, so the old 80ms nudge — and
// the competing re-fit that collapsed the one-row dip within a frame — sampled
// the unchanged size and emitted nothing. Refresh looked like a no-op no matter
// how often you pressed it. The nudge must now hold the smaller size long enough
// (REPAINT_NUDGE_MS) and resist the competing fit, so the TUI actually repaints.
test('Refresh repaints a debounced alt-screen TUI (the opencode case)', async () => {
  const booted = await bootApp({ globalConfig: { layout: { terminal: true } } });
  booted.window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  try {
    await booted.window.evaluate(() => {
      document.body.setAttribute('data-test-xterm-registry', '');
    });

    const term = await booted.window.evaluate(
      (script) => window.condash.termSpawn({ side: 'my', command: `node ${script}` }),
      DEBOUNCE_TUI,
    );
    await booted.window.waitForSelector(`[data-sid="${term.id}"]`, {
      state: 'attached',
      timeout: 5000,
    });
    await waitForDomTerm(booted.window, term.id);

    // Wait for the TUI to paint and confirm it's on the alternate buffer. (The
    // initial mount-fit already drives one resize repaint, so the count starts
    // above 1 — which itself shows the nudge mechanism reaches this program.)
    await expect
      .poll(() => latestPaintCount(booted.window, term.id), { timeout: 5000 })
      .toBeGreaterThan(0);
    expect(await isAltBuffer(booted.window, term.id), 'TUI is on the alt buffer').toBe(true);

    // Let the mount-driven repaints settle, then baseline. A single static tab
    // has no more ambient fits, so only Refresh can move the count from here.
    await wait(500);
    const before = await latestPaintCount(booted.window, term.id);

    // Refresh must drive at least one more repaint past the debounce.
    await booted.window.click('[data-label="refresh"]');
    await expect
      .poll(() => latestPaintCount(booted.window, term.id), { timeout: 5000 })
      .toBeGreaterThan(before);

    // Tab is still live and back at its full size after the nudge settled.
    await wait(400);
    await waitForDomTerm(booted.window, term.id);
    expect(await rowsOf(booted.window, term.id), 'tab live after refresh').toBeGreaterThan(1);

    await booted.window.evaluate((id) => window.condash.termClose(id), term.id);
  } finally {
    await booted.cleanup();
  }
});

// `autoRefreshOnTabSwitch` defaults to true, so switching to any tab runs
// Refresh. Plain shells have nothing to repaint, so we assert via the refresh
// log; alt-screen TUIs additionally show a real paint advance.
test('auto-refresh (default): every tab repaints on switch', async () => {
  const booted = await bootApp({ globalConfig: { layout: { terminal: true } } });
  booted.window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  try {
    await booted.window.evaluate(() => {
      document.body.setAttribute('data-test-xterm-registry', '');
    });

    // A plain shell and a full-screen TUI. The TUI ('tui') is spawned last, so
    // it is active; 'sh' parses in the worker until we switch to it.
    const tui = await booted.window.evaluate(
      (script) => window.condash.termSpawn({ side: 'my', command: `node ${script}` }),
      DEBOUNCE_TUI,
    );
    const sh = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "SHELL\n"; sleep 30' }),
    );
    await booted.window.waitForSelector(`[data-sid="${tui.id}"]`, {
      state: 'attached',
      timeout: 5000,
    });
    await booted.window.waitForSelector(`[data-sid="${sh.id}"]`, {
      state: 'attached',
      timeout: 5000,
    });
    await waitForDomTerm(booted.window, sh.id);

    // Switch to the plain shell: with the default on it must be logged.
    await booted.window.click(`[data-sid="${sh.id}"]`);
    await waitForDomTerm(booted.window, sh.id);
    await expect.poll(() => refreshLog(booted.window), { timeout: 5000 }).toContain(sh.id);

    // Switch back to the TUI: logged and actually repainted.
    await booted.window.click(`[data-sid="${tui.id}"]`);
    await waitForDomTerm(booted.window, tui.id);
    await expect.poll(() => refreshLog(booted.window), { timeout: 5000 }).toContain(tui.id);
    await expect
      .poll(() => latestPaintCount(booted.window, tui.id), { timeout: 5000 })
      .toBeGreaterThan(1);

    await booted.window.evaluate((id) => window.condash.termClose(id), tui.id);
    await booted.window.evaluate((id) => window.condash.termClose(id), sh.id);
  } finally {
    await booted.cleanup();
  }
});

// With `autoRefreshOnTabSwitch` explicitly false, only alternate-buffer tabs
// are auto-refreshed — plain shells hydrate faithfully and are left alone.
test('auto-refresh opt-out: alt-screen tab repaints on switch, plain shell does not', async () => {
  const booted = await bootApp({
    globalConfig: {
      layout: { terminal: true },
      terminal: { autoRefreshOnTabSwitch: false },
    },
  });
  booted.window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  try {
    await booted.window.evaluate(() => {
      document.body.setAttribute('data-test-xterm-registry', '');
    });

    const tui = await booted.window.evaluate(
      (script) => window.condash.termSpawn({ side: 'my', command: `node ${script}` }),
      DEBOUNCE_TUI,
    );
    const sh = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "SHELL\n"; sleep 30' }),
    );
    await booted.window.waitForSelector(`[data-sid="${tui.id}"]`, {
      state: 'attached',
      timeout: 5000,
    });
    await booted.window.waitForSelector(`[data-sid="${sh.id}"]`, {
      state: 'attached',
      timeout: 5000,
    });
    await waitForDomTerm(booted.window, sh.id);

    // Switch to the plain shell: with the setting off it must NOT be refreshed.
    await booted.window.click(`[data-sid="${sh.id}"]`);
    await waitForDomTerm(booted.window, sh.id);
    await wait(600); // give any (unwanted) auto-refresh time to log itself
    expect(await refreshLog(booted.window), 'plain shell not auto-refreshed').not.toContain(sh.id);

    // Switch back to the TUI: it is on the alt buffer, so it must auto-refresh.
    await booted.window.click(`[data-sid="${tui.id}"]`);
    await waitForDomTerm(booted.window, tui.id);
    await expect.poll(() => refreshLog(booted.window), { timeout: 5000 }).toContain(tui.id);
    await expect
      .poll(() => latestPaintCount(booted.window, tui.id), { timeout: 5000 })
      .toBeGreaterThan(1);

    await booted.window.evaluate((id) => window.condash.termClose(id), tui.id);
    await booted.window.evaluate((id) => window.condash.termClose(id), sh.id);
  } finally {
    await booted.cleanup();
  }
});
