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

/** Opt into the test-only xterm registry for THIS document and every later one.
 *  `mountXterm` reads the attribute at mount time, and a renderer reload starts
 *  from a clean DOM — so a spec that reloads must arm the registry from an init
 *  script, before any app code runs, or the post-reload mounts are invisible. */
async function armXtermRegistry(window: Page): Promise<void> {
  await window.addInitScript(() => {
    const arm = () => document.body?.setAttribute('data-test-xterm-registry', '');
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', arm, { once: true });
    } else {
      arm();
    }
  });
  await window.evaluate(() => document.body.setAttribute('data-test-xterm-registry', ''));
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

/** Spawn the fixture TUI, wait for it to paint at the pty's real size, freeze it,
 *  and return its id plus the frame it painted. Shared by both tests: they differ
 *  only in how the tab is torn down and brought back. */
async function spawnFrozenTui(
  window: Page,
): Promise<{ id: string; painted: string[]; cols: number; rows: number }> {
  const tui = await window.evaluate(
    (script) => window.condash.termSpawn({ side: 'my', command: `node ${script}` }),
    STATIC_TUI,
  );
  await window.waitForSelector(`[data-sid="${tui.id}"]`, { state: 'attached', timeout: 5000 });
  await waitForDomTerm(window, tui.id);

  // The pane is wider than the 80-column default, so a frame painted for the pty
  // cannot survive a replay at 80 columns. Without that margin the test would
  // assert nothing.
  await expect
    .poll(async () => (await termState(window, tui.id)).cols, { timeout: 5000 })
    .toBeGreaterThan(80);
  const state = await termState(window, tui.id);
  expect(state.alt, 'the TUI runs on the alternate buffer').toBe(true);

  // Let the mount-driven fit settle, then freeze the program so nothing can
  // repaint over a bad hydrate.
  await expect
    .poll(async () => (await readGrid(window, tui.id))[0], { timeout: 5000 })
    .toContain(`cols=${state.cols} rows=${state.rows}`);
  await window.evaluate((id) => window.condash.termWrite(id, 'F'), tui.id);
  await expect
    .poll(async () => (await readGrid(window, tui.id))[0], { timeout: 5000 })
    .toContain('FROZEN');

  const painted = await readGrid(window, tui.id);
  // Self-checks on the fixture: the frame is width-filling (so a replay at any
  // other width must move the sentinel and fail the comparison), it records the
  // geometry it was painted for, and it fills EVERY row — including the bottom
  // one the repaint nudge used to shear off.
  expect(painted[0].length, 'row 1 fills the pty width').toBe(state.cols);
  expect(painted[0], 'row 1 records the geometry it was painted for').toContain(
    `cols=${state.cols} rows=${state.rows}`,
  );
  expect(painted.length, 'the frame covers every row').toBe(state.rows);
  expect(painted[state.rows - 1], 'the bottom row is painted, not blank').toContain(
    `ROW${state.rows} `,
  );

  return { id: tui.id, painted, cols: state.cols, rows: state.rows };
}

test('a hidden→visible tab hydrates into the frame its pty last painted', async () => {
  const booted = await bootApp({ globalConfig: { layout: { terminal: true } } });
  booted.window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  try {
    await armXtermRegistry(booted.window);
    const tui = await spawnFrozenTui(booted.window);
    const before = { cols: tui.cols, rows: tui.rows };
    const painted = tui.painted;

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

// The other half of the same fix, and the half nothing covered: a renderer reload
// rebuilds every tab through `reconcile` → `termAttach`, replaying the raw 64 KB
// pty tail into a brand-new Terminal. That replay has the identical problem — at
// 80×24 a wider pty's output wraps and the alternate buffer cannot un-wrap it —
// and this path is *worse* off than the switch path, because no repaint nudge
// ever fires here: `refreshOnSwitchTargets` needs a previous active id to
// switch away from, and after a reload there is none.
//
// This test is also the guard against the fix being silently half-reverted. The
// `geometry` argument is an optional trailing parameter, so dropping it at the
// reconcile call site — which is exactly what resolving a merge conflict in
// favour of a branch that predates it would do — leaves the typecheck clean and
// the switch-path test above still passing.
test('a tab restored after a renderer reload hydrates into the frame its pty last painted', async () => {
  const booted = await bootApp({ globalConfig: { layout: { terminal: true } } });
  booted.window.on('console', (msg) => console.log('RENDERER CONSOLE:', msg.text()));
  try {
    await armXtermRegistry(booted.window);
    const tui = await spawnFrozenTui(booted.window);

    // Reload the renderer. The pty survives in the main process — with its
    // winsize — and the fresh renderer rebuilds the tab from scratch.
    await booted.window.reload();
    await booted.window.waitForLoadState('domcontentloaded');
    await booted.window.waitForSelector(`[data-sid="${tui.id}"]`, {
      state: 'attached',
      timeout: 10_000,
    });
    await waitForDomTerm(booted.window, tui.id, 10_000);

    await expect
      .poll(
        async () => {
          const { cols, rows } = await termState(booted.window, tui.id);
          return { cols, rows };
        },
        { timeout: 5000 },
      )
      .toEqual({ cols: tui.cols, rows: tui.rows });
    expect(
      (await termState(booted.window, tui.id)).alt,
      'still on the alternate buffer after the reload',
    ).toBe(true);

    // The invariant, restated for the restore path: the program has painted
    // nothing since the freeze, so the pty's screen is still `tui.painted`.
    await expect
      .poll(() => readGrid(booted.window, tui.id), { timeout: 5000 })
      .toEqual(tui.painted);

    await booted.window.evaluate((id) => window.condash.termClose(id), tui.id);
  } finally {
    await booted.cleanup();
  }
});
