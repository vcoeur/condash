// A minimal stand-in for a live full-screen TUI (opencode / Bubbletea) used by
// terminal-refresh.spec.ts. It reproduces the two traits that made opencode
// never repaint on Refresh:
//
//   1. It runs on the alternate screen buffer (`\x1b[?1049h`), like every
//      full-screen TUI — so condash's auto-refresh treats it as one.
//   2. It DEBOUNCES resize and only repaints when the row count actually
//      changed. So a nudge that doesn't hold the smaller size past the debounce
//      window, or that gets collapsed back to full size by a competing fit,
//      samples the unchanged size and emits nothing — exactly the old bug.
//
// Each repaint bumps a counter and reprints `TUI-PAINT#<n>`; the test asserts the
// counter advances after Refresh, which only happens when the nudge lands.

const out = process.stdout;
const DEBOUNCE_MS = 90; // < REPAINT_NUDGE_MS (160) but well above the old 80ms

let count = 0;
let lastRows = -1;

function paint() {
  count += 1;
  lastRows = out.rows;
  // Home + reprint the marker. No clear — like opencode, which redraws by
  // cursor-addressing and never emits an erase.
  out.write(`\x1b[H\x1b[2KTUI-PAINT#${count} rows=${out.rows}\r\n`);
}

out.write('\x1b[?1049h'); // enter the alternate screen buffer
paint();

let timer = null;
out.on('resize', () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    // Only a genuine row-count change forces a redraw (Bubbletea semantics): a
    // nudge that collapses back to the original size samples no change here.
    if (out.rows !== lastRows) paint();
  }, DEBOUNCE_MS);
});

// Keep the process (and its pty) alive until the test closes the tab.
setInterval(() => {}, 1 << 30);
