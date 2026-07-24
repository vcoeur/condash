import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

// THE INVARIANT: after a tab has been switched away from and back, the visible
// grid must equal the screen the pty last painted.
//
// Every previous regression test in this area pins a *mechanism* — that
// `__condashRefreshLog` recorded an id, that `cols > 80` — and seven fixes
// across five rounds all passed those while the "stale until I hit Refresh"
// class survived. The property those tests never stated is the one the user
// actually reports, so it is stated here directly: capture the frame, switch
// away, switch back, compare grids.
//
// The tab runs a full-screen TUI that paints once and then freezes (see
// tests/fixtures/static-frame-tui.mjs). Freezing is what makes this an assertion
// about hydration: condash's repaint nudge would otherwise make a cooperating
// program redraw and repair a mangled hydrate after the fact, so a
// nudge-repaired frame and a correctly-hydrated one are indistinguishable. With
// the program frozen, only the hydrate can produce the right frame.
//
// Before the hydrate-at-pty-geometry fix this test fails: the promote built the
// replacement `Terminal` at xterm's 80×24 constructor default and replayed the
// snapshot into it *before* any fit, and the alternate buffer never reflows on
// resize (`Buffer._isReflowEnabled` returns `_hasScrollback`, false for the alt
// buffer), so the frame was wrapped to 80 columns and then frozen there.

const STATIC_TUI = resolve(__dirname, 'fixtures', 'static-frame-tui.mjs');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The live DOM Terminal's grid: one entry per visible row, right-trimmed. */
async function readGrid(window: Page, sid: string): Promise<string[]> {
  return window.evaluate((id) => {
    const term = window.__condashXterms?.get(id);
    if (!term) return ['NO-TERM'];
    const buffer = term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < term.rows; y++) {
      rows.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
    }
    return rows;
  }, sid);
}

/** `{ cols, rows, alt }` of the live DOM Terminal, or nulls when there is none. */
async function termState(
  window: Page,
  sid: string,
): Promise<{ cols: number; rows: number; alt: boolean }> {
  return window.evaluate((id) => {
    const term = window.__condashXterms?.get(id);
    if (!term) return { cols: -1, rows: -1, alt: false };
    return { cols: term.cols, rows: term.rows, alt: term.buffer.active.type === 'alternate' };
  }, sid);
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

test('a hidden→visible tab hydrates into the frame its pty last painted', async () => {
  const booted = await bootApp({ globalConfig: { layout: { terminal: true } } });
  booted.window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  try {
    await booted.window.evaluate(() => {
      document.body.setAttribute('data-test-xterm-registry', '');
    });

    const tui = await booted.window.evaluate(
      (script) => window.condash.termSpawn({ side: 'my', command: `node ${script}` }),
      STATIC_TUI,
    );
    await booted.window.waitForSelector(`[data-sid="${tui.id}"]`, {
      state: 'attached',
      timeout: 5000,
    });
    await waitForDomTerm(booted.window, tui.id);

    // The pane is wider than the 80-column default, so a frame painted for the
    // pty cannot survive a replay at 80 columns. Without that margin the test
    // would assert nothing.
    await expect
      .poll(async () => (await termState(booted.window, tui.id)).cols, { timeout: 5000 })
      .toBeGreaterThan(80);
    const before = await termState(booted.window, tui.id);
    expect(before.alt, 'the TUI runs on the alternate buffer').toBe(true);

    // Let the mount-driven fit settle, then freeze the program so nothing can
    // repaint over a bad hydrate.
    await expect
      .poll(async () => (await readGrid(booted.window, tui.id))[0], { timeout: 5000 })
      .toContain(`cols=${before.cols} rows=${before.rows}`);
    await booted.window.evaluate((id) => window.condash.termWrite(id, 'F'), tui.id);
    await expect
      .poll(async () => (await readGrid(booted.window, tui.id))[0], { timeout: 5000 })
      .toContain('FROZEN');

    const painted = await readGrid(booted.window, tui.id);
    // Self-check on the fixture: the frame really is width-filling, so a replay
    // at any other width must move the sentinel and fail the comparison below.
    expect(painted[0].length, 'row 1 fills the pty width').toBe(before.cols);
    expect(painted[0], 'row 1 records the geometry it was painted for').toContain(
      `cols=${before.cols} rows=${before.rows}`,
    );

    // A second tab to switch to; spawning it demotes the TUI into the worker.
    const other = await booted.window.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: 'printf "OTHER\n"; sleep 30' }),
    );
    await booted.window.waitForSelector(`[data-sid="${other.id}"]`, {
      state: 'attached',
      timeout: 5000,
    });
    await waitForDomTerm(booted.window, other.id);

    // Switch back. The repaint nudge holds the grid one row short for 160 ms and
    // fits again 150 ms after restoring, so wait past that whole sequence before
    // reading — then poll, so a restore that lands a few frames late is a slow
    // pass rather than a flake. Nothing else can change the grid meanwhile: the
    // program is frozen and the alternate buffer does not reflow.
    await booted.window.click(`[data-sid="${tui.id}"]`);
    await waitForDomTerm(booted.window, tui.id);
    await wait(500);

    await expect
      .poll(
        async () => {
          const { cols, rows } = await termState(booted.window, tui.id);
          return { cols, rows };
        },
        { timeout: 5000 },
      )
      .toEqual({ cols: before.cols, rows: before.rows });
    expect(
      (await termState(booted.window, tui.id)).alt,
      'still on the alternate buffer after the switch',
    ).toBe(true);

    // The invariant. The program has painted nothing since the freeze, so the
    // pty's screen is still `painted` — and that is what must be on display.
    await expect.poll(() => readGrid(booted.window, tui.id), { timeout: 5000 }).toEqual(painted);

    await booted.window.evaluate((id) => window.condash.termClose(id), tui.id);
    await booted.window.evaluate((id) => window.condash.termClose(id), other.id);
  } finally {
    await booted.cleanup();
  }
});
