// Echo-probe TUI for the terminal-acceptance harness.
//
// Reads its pty stdin in raw mode and writes one `ACK <token>` line to stdout
// per `P<number>` token found, so an acceptance probe can measure
// termWrite → parsed-buffer-visible round-trip latency against a live DOM
// terminal (the plan's first-useful-frame primitive, buffer level). Modeled on
// tests/fixtures/static-frame-tui.mjs: raw mode so the pty's own echo cannot
// double-print input (the census counts `ACK <token>` lines, which the kernel
// echo never produces), and an explicit freeze so a spec can stop the echoes
// and know nothing further will disturb the buffer.
//
// Modes:
//   default        echo — every token is answered with `ACK <token>`.
//   --absorb       swallow input silently; used as the negative control that
//                  proves the harness's census detects absence, not just
//                  presence.
//   standalone F   freeze — echoes stop and `FROZEN` is printed once. Like the
//                  static frame's freeze, explicit via input, never timed.
//
// Token scanning carries a tail between stdin chunks so a token split across
// two reads is still answered exactly once. `ECHO-PROBE READY` on stdout marks
// boot; specs wait for it instead of guessing a delay.

const out = process.stdout;

const absorb = process.argv.includes('--absorb');
let frozen = false;
// Answered tokens, so a token split across stdin chunks (or a carry that
// re-scans one) is answered exactly once — duplicate ACK lines would corrupt a
// received-token census.
const answered = new Set();

out.write(`ECHO-PROBE READY pid=${process.pid} mode=${absorb ? 'absorb' : 'echo'}\n`);

let carry = '';
process.stdin.on('data', (chunk) => {
  if (frozen) return;
  const text = carry + chunk.toString('utf8');
  // Freeze is explicit: a chunk that is nothing but F (the spec termWrites it
  // alone). Anything else falls through to token handling.
  if (text.trim() === 'F') {
    frozen = true;
    out.write('FROZEN\n');
    return;
  }
  if (absorb) {
    carry = text.slice(-16);
    return;
  }
  // Answer each unseen P<number> token once; keep the tail from the start of
  // the last (possibly partial) token so chunk boundaries cannot split one.
  for (const token of text.match(/P\d+/g) ?? []) {
    if (answered.has(token)) continue;
    answered.add(token);
    out.write(`ACK ${token}\n`);
  }
  const last = text.search(/P\d+(?!.*P\d)/s);
  carry = last >= 0 ? text.slice(last) : text.slice(-16);
  if (carry.length > 64) carry = '';
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

// Keep the process (and its pty) alive until the spec closes the tab.
setInterval(() => {}, 1 << 30);
