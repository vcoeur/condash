// A full-screen TUI that paints ONE frame sized to its pty and then stops
// repainting. Used by terminal-hydrate-geometry.spec.ts to assert the hydrate
// invariant: after a switch away and back, the visible grid must still equal the
// screen the program painted.
//
// Why it must stop repainting: condash's repaint nudge (resize one row shorter
// and back → SIGWINCH) makes a *cooperating* program redraw, which repairs a
// mangled hydrate after the fact and hides whether the hydrate itself was
// correct. Freezing removes that compensation, so the assertion is about the
// hydrate alone. Programs that repaint on their own schedule rather than on
// SIGWINCH — or whose resize debounce outlasts the 160 ms nudge — behave this
// way in the field too.
//
// Two properties make the frame width- and height-sensitive, so replaying it
// into a differently-sized grid cannot accidentally still match:
//
//   1. Every painted row is exactly `columns` characters wide and ends in a
//      per-row sentinel, so any other width wraps the row and moves the
//      sentinel off the right edge.
//   2. Row 1 states the geometry it was painted for, so the visible frame can be
//      checked against the terminal's actual size rather than only against
//      itself.
//
// The frame fills EVERY row, bottom row included. It used to leave the last row
// blank, which quietly accommodated a real defect: condash's repaint nudge
// shrinks the grid a row and grows it back, and on the alternate buffer — which
// never reflows — xterm services that by popping the bottom line and pushing a
// fresh blank one (`Buffer.resize`), shearing the bottom row off a frame that was
// correct. A fixture that never used that row could not see it. The nudge is now
// skipped when the hydrated frame is provably exact, so painting the full frame
// asserts the whole grid rather than the grid minus the row the nudge destroys.
//
// Freeze is explicit, not timed: the test writes "F" to the pty and waits for the
// FROZEN marker, so there is no settling race.

const out = process.stdout;

let frozen = false;

function paint() {
  const cols = out.columns;
  const rows = out.rows;
  const state = frozen ? 'FROZEN' : 'LIVE';
  // Erase the whole screen first. Repainting row-by-row would leave whatever the
  // previous (differently-sized) paint put on the rows this one does not reach —
  // the alternate buffer never reflows, so a shrink just drops rows off the
  // bottom and the survivors keep their old text.
  let frame = '\x1b[H\x1b[2J';
  // Every row, 1..rows (1-based) — see the header on why the bottom one matters.
  for (let row = 1; row <= rows; row++) {
    const head = row === 1 ? `TUI ${state} cols=${cols} rows=${rows} ` : `ROW${row} `;
    const sentinel = `|${row % 10}|`;
    const fillWidth = Math.max(0, cols - head.length - sentinel.length);
    const line = (head + '='.repeat(fillWidth) + sentinel).slice(0, cols);
    frame += `\x1b[${row};1H\x1b[2K${line}`;
  }
  // Park the cursor at home. Writing the bottom row leaves the cursor there, and
  // an alt-buffer shrink with the cursor on the last line trims from the TOP
  // instead of popping the bottom — a different corruption again.
  frame += '\x1b[H';
  out.write(frame);
}

out.write('\x1b[?1049h'); // enter the alternate screen buffer
paint();

let timer = null;
out.on('resize', () => {
  if (frozen) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(paint, 50);
});

// Raw mode so the freeze keystroke is not echoed into the frame.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  if (frozen || !chunk.includes('F')) return;
  frozen = true;
  if (timer) clearTimeout(timer);
  paint();
});
process.stdin.resume();

// Keep the process (and its pty) alive until the test closes the tab.
setInterval(() => {}, 1 << 30);
