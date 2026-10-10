// Deterministic sustained/burst generator for the terminal-acceptance harness.
//
// Emits printable-ASCII lines at a pinned byte rate until an exact byte budget,
// carrying in-stream probe tokens for the received-token census. Disciplines
// reused from scripts/perf-load.mjs: seeded xorshift determinism (both arms of
// a comparison must see a byte-identical load), exactly-lengthed lines whose
// last character is never blank (trailing blanks render shorter than written
// and silently drag the achieved rate), and a final accounting line so the
// spec records what was actually scheduled rather than what it assumed.
//
// Burst identity (the parent's, pinned — asserted by self-checks):
// 128 KiB/s × 30 s = 3,932,160 bytes exactly, 64 sequence-numbered tokens
// interleaved, plus the parent's 100-short-line probe block.
//
// Exactly 64 tokens are required. The spec measures actual fitted columns and
// mounted scrollback, counts wrapped/control rows and requires the final full
// renderer census. A requested preference or a row-times-column byte estimate
// does not establish retention; eviction is a failed gate.
//
// PAYLOAD-BEGIN / PAYLOAD-END delimit payload bytes from framing. The process
// stays alive (specs close the tab) so an exited tab can never unmount the
// buffer a census is about to read.

const out = process.stdout;

// ---- pinned identity constants (mirrored by the specs' assertions) ----
const BURST_RATE_BYTES_PER_SEC = 128 * 1024;
const BURST_SECONDS = 30;

function fail(message) {
  out.write(`SUSTAIN-FATAL ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    mode: 'sustain',
    rate: 16 * 1024,
    budget: 64 * 1024,
    tokens: 0,
    shortLines: 0,
    lineBytes: 1023,
    seed: 0x5eed1e55,
    echo: false,
    hold: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'echo') {
      args.echo = true;
      continue;
    }
    if (key === 'hold') {
      // Wait for GO so the observer and naturally fitted terminal are ready.
      args.hold = true;
      continue;
    }
    if (!['mode', 'rate', 'budget', 'tokens', 'shortLines', 'lineBytes', 'seed'].includes(key)) {
      fail(`unknown argument ${argv[i]}`);
    }
    args[key] = key === 'mode' ? argv[i + 1] : Number(argv[i + 1]);
    i++;
  }
  if (args.mode === 'burst') {
    args.rate = BURST_RATE_BYTES_PER_SEC;
    if (args.tokens === 0) args.tokens = 64;
    if (args.shortLines === 0) args.shortLines = 100;
  }
  return args;
}

// xorshift32 — seeded determinism, same generator as perf-load.
function makeRandom(seed) {
  let state = seed >>> 0 || 1;
  return (bound) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % bound;
  };
}

const WORDS = [
  'resolved', 'emitted', 'chunk', 'module', 'cached', 'skipped', 'rebuilt',
  'entry', 'bytes', 'window', 'session', 'flushed', 'parsed', 'scanned',
  'batch', 'steady', 'fresh', 'stale', 'queued', 'drained',
];

/** One line of EXACTLY `length` printable ASCII, last char never blank. */
function synthLine(length, random) {
  let text = `[${String(random(24)).padStart(2, '0')}:${String(random(60)).padStart(2, '0')}:${String(random(60)).padStart(2, '0')}.${String(random(1000)).padStart(3, '0')}] steady`;
  while (text.length < length) text += ` ${WORDS[random(WORDS.length)]}`;
  text = text.slice(0, length);
  return text.endsWith(' ') ? `${text.slice(0, -1)}.` : text;
}

// ---- plan: the exact byte composition, computed and pinned up front ----
const args = parseArgs(process.argv.slice(2));
const totalBytes = args.mode === 'burst' ? args.rate * BURST_SECONDS : args.budget;

const shortBlock = [];
let shortBlockBytes = 0;
for (let i = 0; i < args.shortLines; i++) {
  const text = synthLine(96, makeRandom(args.seed + i));
  shortBlock.push(text);
  shortBlockBytes += text.length + 1;
}

// Token lines carry the census needle padded to `lineBytes`, so they keep the
// mean-line pin and the byte total stays trivially accountable.
const tokenLabels = [];
let tokenBlockBytes = 0;
for (let i = 0; i < args.tokens; i++) {
  const label = `PROBE TKN-${String(i).padStart(3, '0')}`;
  if (label.length > args.lineBytes) fail(`token label longer than lineBytes`);
  tokenLabels.push(label + '#'.repeat(args.lineBytes - label.length));
  tokenBlockBytes += args.lineBytes + 1;
}

const payloadBudget = totalBytes - shortBlockBytes - tokenBlockBytes;
if (payloadBudget < args.lineBytes) {
  fail(`budget ${totalBytes} too small for ${args.tokens} tokens + ${args.shortLines} short lines`);
}
const random = makeRandom(args.seed);
const fullPayloadLines = Math.floor(payloadBudget / (args.lineBytes + 1));
const lastPayloadLength =
  payloadBudget - fullPayloadLines * (args.lineBytes + 1) - 1; // -1: its newline

// Token lines interleave by BYTE OFFSET (count-scheduled), never by clock:
// token i rides once cumulative scheduled payload bytes cross (i+1)/(tokens+1)
// of the payload budget. One ordered offset list; labels stay in stream order.
const tokenOffsets = [];
for (let i = 0; i < args.tokens; i++) {
  tokenOffsets.push(
    Math.floor((payloadBudget * (i + 1)) / (args.tokens + 1) / (args.lineBytes + 1)),
  );
}
tokenOffsets.sort((a, b) => a - b);

const lines = [...shortBlock];
let payloadIndex = 0;
let tokenIndex = 0;
while (payloadIndex < fullPayloadLines) {
  lines.push(synthLine(args.lineBytes, random));
  payloadIndex++;
  if (tokenIndex < tokenOffsets.length && tokenOffsets[tokenIndex] < payloadIndex) {
    lines.push(tokenLabels[tokenIndex]);
    tokenIndex++;
  }
}
if (lastPayloadLength > 0) lines.push(synthLine(lastPayloadLength, random));
// The offsets all sit strictly inside the payload, so every token was placed;
// a residual one would silently shrink the census population.
if (tokenIndex !== tokenOffsets.length) {
  fail(`only ${tokenIndex}/${tokenOffsets.length} tokens placed in the stream plan`);
}

let scheduled = 0;
for (const text of lines) scheduled += text.length + 1;
// The partial last line's rounding is repaired, never absorbed: the identity
// is byte-exact or the fixture refuses to run.
if (scheduled !== totalBytes) {
  const drift = totalBytes - scheduled;
  const last = lines[lines.length - 1];
   const repaired =
     drift > 0 ? synthLine(last.length + drift, random) : last.slice(0, last.length + drift);
   lines[lines.length - 1] = repaired;
   scheduled = lines.reduce((sum, line) => sum + line.length + 1, 0);
   if (scheduled !== totalBytes) fail(`unrepaired byte drift: ${scheduled}/${totalBytes}`);
}

// ---- self-checks: the coverage pins, with the arithmetic in the failure ----
const totalLines = lines.length;
if (args.mode === 'burst') {
  if (totalBytes !== args.rate * BURST_SECONDS) {
    fail(`identity broken: total ${totalBytes} != rate ${args.rate} x ${BURST_SECONDS}s`);
  }
  if (args.tokens !== 64) {
    fail(`burst token population must be exactly 64, got ${args.tokens}`);
  }
}
// Retention is checked by the spec against actual mounted geometry, including wraps.

// ---- stdin echo (sustain probes only; burst census must stay unpolluted) ----
let echoOn = args.echo;
let carry = '';
const answered = new Set();
let go = !args.hold;
let goResolve = null;
const goPromise = new Promise((resolve) => {
  goResolve = resolve;
});
process.stdin.on('data', (chunk) => {
  const text = carry + chunk.toString('utf8');
  if (!go && text.includes('GO')) {
    go = true;
    goResolve?.();
  }
  const boundary = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n'), text.lastIndexOf('\r'));
  const complete = boundary >= 0 ? text.slice(0, boundary + 1) : '';
  for (const token of complete.match(/P\d+\b/g) ?? []) {
    if (!echoOn || answered.has(token)) continue;
    answered.add(token);
    out.write(`ACK ${token}\n`);
  }
  carry = go && text.includes('GO') ? '' : text.slice(boundary + 1);
  if (carry.length > 64) fail('unterminated probe input');
  if (text.trim() === 'Q') echoOn = false;
});
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

// ---- emit on a paced schedule; the byte total is the identity ----
out.write(
  `SUSTAIN-READY mode=${args.mode} total=${totalBytes} lines=${totalLines} ` +
    `tokens=${args.tokens} seed=${args.seed}\n`,
);

// The schedule starts (t=0) when GO arrives — or immediately without --hold —
// so the achieved rate is measured over generation time only.
const startedAtPromise = go ? Promise.resolve(Date.now()) : goPromise.then(() => Date.now());

const cumulativeBytes = [0];
for (const text of lines) cumulativeBytes.push(cumulativeBytes[cumulativeBytes.length - 1] + text.length + 1);
let index = 0;

// Backpressure discipline: `out.write` into a paused pty queues in this
// process's stream buffer, and a deep queue would (a) strand a probe ACK
// behind hundreds of kilobytes of flood and (b) collapse its viewport
// visibility window when the queue drains in one burst. So when the stream
// buffers, the schedule stops and REBASES onto the drain instant — the
// remaining lines keep the requested rate from the moment the pipe accepts
// again. The byte total is untouched; only the wall clock stretches, and the
// DONE line reports the achieved elapsed time.
let startedAt = 0;
let realStartedAt = 0;

function emitNext() {
  while (index < lines.length) {
    const dueMs = startedAt + (cumulativeBytes[index + 1] * 1000) / args.rate;
    const now = Date.now();
    if (dueMs > now) {
      setTimeout(emitNext, dueMs - now);
      return;
    }
    const line = lines[index];
    index++;
    if (!out.write(`${line}\n`)) {
      out.once('drain', () => {
        startedAt = Date.now() - (cumulativeBytes[index] * 1000) / args.rate;
        emitNext();
      });
      return;
    }
  }
  const elapsedMs = Date.now() - realStartedAt;
  out.write(`PAYLOAD-END ${scheduled} ${elapsedMs}\nDONE\n`);
  // Stay alive so the spec closes the tab after its census — an exited tab
  // must never unmount the buffer mid-read.
  setInterval(() => {}, 1 << 30);
}

startedAtPromise.then((start) => {
  startedAt = start;
  realStartedAt = start;
  out.write('PAYLOAD-BEGIN\n');
  emitNext();
});
