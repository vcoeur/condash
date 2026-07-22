#!/usr/bin/env node
// Stage a controlled multi-tab terminal output flood and capture what it costs.
//
// The 2026-07-21 performance audit derived exact complexity for every stage of
// the terminal byte path but measured no constants, so it could not say which
// stage dominates wall-clock, whether the 12 ms flush timer actually fires at
// 12 ms under load, whether the pty ever genuinely pauses, or how much of the
// perceived lag is GC. This harness produces those numbers.
//
// Complements scripts/perf-baseline.mjs: that one samples CPU across idle and
// interaction windows on a resting app; this one drives N tabs at a known byte
// rate and reads the in-app perf counters (src/main/perf-log.ts) back out.
//
// The headline experiment is the logging A/B. With terminal.logging.enabled on,
// main runs a second full headless-xterm ANSI parse of every byte, duplicating
// the renderer's parse on the shared main thread. Running the same load with it
// on and off isolates that cost, settling audit finding F5.
//
// GC is measured, not assumed: --trace-gc is on by default because major-GC
// pauses present exactly as the reported lag while being invisible to every
// counter the app records itself. Turning it off is an explicit choice.
//
// ## Isolation
//
// The harness runs against a THROWAWAY user-data dir and a THROWAWAY conception,
// both under /tmp, and asserts that isolation at runtime before applying any
// load. This is not tidiness — an earlier version drove the user's real app
// state and did real damage:
//
//   - it enabled `terminal.logging` and `perf.enabled` in the user's own
//     settings.json and never restored them, so a default run left full disk
//     transcription of every terminal byte permanently on, and an --ab run left
//     it permanently off for someone who had deliberately enabled it;
//   - it flooded into the user's real `.condash/logs/`, where the janitor evicts
//     whole day-directories oldest-first to stay under its cap and never evicts
//     today — so the harness's own junk was protected and the eviction victims
//     were the user's real prior-day agent transcripts;
//   - it appended to the same `.condash/perf/<day>.jsonl` the user's own running
//     instance was writing, silently mixing two instances' records into one A/B.
//
// Isolation removes that entire class, and removes the need for a restore path
// that a Ctrl-C would skip anyway.
//
// ## Memory safety
//
// N tabs at MemoryMax=8G each is 8N GB of nominal headroom, and the documented
// field failure is systemd-oomd killing at MemoryHigh under whole-machine PSI
// pressure — which per-tab caps by construction do not prevent. So the harness
// checks actual available memory before spawning and refuses to run a load it
// estimates the machine cannot absorb. --force overrides, deliberately loudly.
//
// ## Load profiles
//
// `--profile` picks the SHAPE of the output, which turns out to matter more than
// the rate. The default stays `flood`, so every invocation that predates this
// flag drives exactly the load it always did.
//
// The disk logger renders its grid body out of a headless xterm of COLS=200,
// ROWS=50, scrollback=5000 — 5050 populated rows at most — and flushes every 5 s
// (`src/main/terminal-logger.ts`; the four constants are mirrored below and the
// mirror is locked by `terminal-logger-harness-mirror.test.ts`). Since v4.97.1
// that render reuses the frozen prefix of the previous one, so its row walk
// costs O(rows that ARRIVED in the flush window) rather than O(rows RETAINED).
// How much output a profile lands in one 5 s window, measured against those 5050
// rows, therefore decides which half of the renderer it exercises at all — and
// until 2026-07-23 this harness only ever exercised one of them.
//
//   --profile flood, --rate 512k (both defaults):
//     chunk = round(512·1024 / 64) = 8192 raw bytes, base64 → 4·ceil(8192/3)
//       = 10924 chars, `tr -d` joins them into ONE line, `echo` adds a newline
//     10925 B/chunk × 64 chunks/s = 699 200 B/s ≈ 683 KB/s per tab
//     that 10924-char line wraps at 200 cols → ceil(10924/200) = 55 rows
//     55 rows × 64 chunks/s = 3520 rows/s → 17 600 rows per 5 s flush
//     17 600 / 5050 = 3.5× FULL BUFFER TURNOVER per flush
//   → nothing at all survives a flush window, so the frozen prefix is empty
//     every time and every render is a full 5050-row walk. Worst-case
//     saturation, which is the right tool for stressing the byte path — but it
//     is structurally blind to any optimisation that depends on rows being
//     retained. Measured 2026-07-23: the v4.97.1 incremental grid render scores
//     EXACTLY ZERO improvement here, and 1.4–1.6× in the regime below.
//
//   --profile realistic, --rate 16k (its default):
//     lines of 80–119 chars (24 distinct lengths, mean 100.6) plus a newline
//       = 101.6 B/row mean, and every line is well under 200 cols so it is
//       exactly ONE row — bytes and rows stop diverging
//     16 384 / 101.6 = 161 rows/s → 806 rows per 5 s flush
//     806 / 5050 = 16 % of the buffer
//   → ~84 % of the buffer is still frozen when the next render runs, which is
//     the only regime in which reuse can be measured at all.
//
// The RATE is the crux here, not the line shape, and this is the easy thing to
// get wrong. Short lines at the FLOOD'S 512k would put 524 288 / 101.6 = 5159
// rows/s, or 25 795 rows, into that 5050-row buffer — 5.1× turnover, i.e. WORSE
// than the flood profile it was meant to fix. A profile that merely looked
// realistic, at the rate this harness already used, would have gone on measuring
// the same zero while appearing to have addressed the problem. (All rows-per-
// flush figures here and in `reportRegime` are keyed to the REQUESTED rate, the
// one an operator types. Against the flood's post-base64 699 200 B/s the same
// arithmetic gives 34 401 rows and 6.8× — a different quantity, and reporting it
// where the code reports the other is how two in-repo sources came to state
// different numbers for the same thing before 2026-07-23.)
//
// One consequence of the low rate: at 161 rows/s the buffer needs ~31 s to
// saturate, against ~1.4 s for the flood. A realistic run shorter than about a
// minute is measuring the warm-up, not the steady state. The harness prints both
// the regime and that warm-up time at startup, and `summarise` DROPS every
// pre-saturation window from its headline ms/render rather than averaging a
// warming buffer in with a full one — see `gridRenderMsPerRenderSteady`.
//
// ## What `realistic` does and does not represent
//
// It is a floor on the grid renderer's cost for a NON-COOPERATING tab, not a
// portrait of a typical tab. Two limits, both found in review on 2026-07-23 and
// both worth keeping in front of anyone quoting a number off this profile:
//
//   1. Neither profile emits anything but printable ASCII and newlines. No
//      alternate screen, no RIS, no `\r` progress bar, no `CSI L` — so
//      `GridBodyRenderer.invalidate()` and the marker-anomaly path are never
//      reached, and the frozen prefix is never dropped mid-run. Real tabs run
//      TUIs and spinners that do exactly that. A real tab's render cost is
//      therefore at least this, not around this.
//   2. More narrowly still: `SessionLogger.flushNow` picks the TRANSCRIPT body
//      whenever `oscTranscript.hasTranscript()` is true
//      (src/main/terminal-logger.ts:626-629), and only falls back to the grid
//      otherwise. Cooperating agent tabs — condash's own dominant logged
//      workload — emit their transcript in-band over OSC 7373 and so skip
//      `GridBodyRenderer` entirely. The grid path serves non-cooperating tabs,
//      and that is the population this profile measures.
//
// Output:
//   /tmp/perf-load/<label>/perf.jsonl    per-window counter records
//   /tmp/perf-load/<label>/gc.log        raw --trace-gc output
//   /tmp/perf-load/summary.json          parsed comparison across labels
//
// Usage:
//   node scripts/perf-load.mjs --tabs 8 --rate 512k --duration 60s
//   node scripts/perf-load.mjs --tabs 8 --rate 512k --duration 60s --logging off
//   node scripts/perf-load.mjs --ab            # runs logging on AND off, compares
//   node scripts/perf-load.mjs --profile realistic --duration 90s
//
//   --profile flood        DEFAULT, behaviour unchanged — worst-case saturation,
//                          and still the documented way to stress the byte path
//   --profile realistic    output shaped like a real tab: short lines, bursty,
//                          sub-saturation, far fewer forks per byte
//   --rate                 per-tab byte rate. The default is PER PROFILE
//                          (512k flood, 16k realistic); an explicit --rate wins
//                          for either, whatever the flag order.

import { _electron as electron } from 'playwright';
import { createWriteStream, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { freemem, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const OUT_DIR = '/tmp/perf-load';

/** Refuse to spawn more than this without --force. Not a technical limit — a
 *  speed bump in front of a load that can take the whole session down. */
const MAX_TABS_UNFORCED = 12;
/** Rough per-tab working set (shell + flood pipeline + the app's buffers). Used
 *  only to compare a planned run against free memory. */
const EST_TAB_BYTES = 96 * 1024 * 1024;
/** Never plan a run that would leave the machine below this. */
const RESERVE_BYTES = 2 * 1024 ** 3;
/** One --trace-gc record, e.g.
 *  `[123:0x…]   842 ms: Scavenge 12.3 (18.0) -> 9.1 (18.0) MB, 1.20 / 0.00 ms`.
 *  Matched on the collector name after the timestamp so Electron's own stdout
 *  chatter is not counted as GC evidence. */
const GC_RECORD = /\bms:\s+(Scavenge|Mark-Compact|Mark-sweep|Minor|Incremental)/;

// ── Headless-logger geometry, MIRRORED from src/main/terminal-logger.ts
// (LOGGER_GRID_GEOMETRY: cols, rows, scrollback, flushMs).
//
// Duplicated rather than imported, and the duplication is LOCKED, not trusted.
// Importing is not available here: this file is plain ESM run by bare `node`,
// the logger is TypeScript, and its relative imports are extensionless under
// `moduleResolution: Bundler` — which Node's type stripping does not resolve.
// (The logger's own runtime graph is electron-free and defers @xterm/headless to
// a lazy require, so the dependency graph is not what blocks it; module
// resolution is.)
//
// Nothing the harness MEASURES depends on these being current — but every regime
// it REPORTS does, and a regime reported wrong is exactly how the flood profile
// went four weeks looking like a valid reading. Until 2026-07-23 the comment
// here claimed `terminal-logger-grid.test.ts` asserted the identity; it does
// not — that test runs its own toy geometry (40×10, scrollback 30) and asserts
// only the SHAPE `bufferRows === SCROLLBACK + ROWS`. Nothing covered `scripts/`
// at all, so changing COLS in the logger would have silently falsified every
// figure below under a green suite. `terminal-logger-harness-mirror.test.ts`
// now reads these four values back out of this file and fails when they drift.
const LOG_COLS = 200;
const LOG_ROWS = 50;
const LOG_SCROLLBACK = 5000;
/** Most populated rows the logger's headless buffer ever holds: scrollback plus
 *  the viewport — the denominator every turnover figure divides by. */
const LOG_BUFFER_ROWS = LOG_SCROLLBACK + LOG_ROWS;
const LOG_FLUSH_MS = 5000;

/** The mirror, exported so the lock test compares the values this harness
 *  ACTUALLY computes with rather than source literals it re-parses. */
export const LOGGER_GEOMETRY_MIRROR = {
  cols: LOG_COLS,
  rows: LOG_ROWS,
  scrollback: LOG_SCROLLBACK,
  flushMs: LOG_FLUSH_MS,
};

/** Chunks per second the flood emits. 64 approximates a chatty agent. Hoisted
 *  out of `floodCommand` because `effectiveRate` needs the same number and kept
 *  its own copy of the literal — two constants that had to agree and nothing
 *  making them. */
const FLOOD_CHUNKS_PER_SEC = 64;

/** Per-profile default byte rate, applied after parsing so an explicit `--rate`
 *  wins whatever the flag order. They differ by 32× on purpose: the profiles
 *  measure opposite sides of the 5050-row buffer, and inheriting the flood's
 *  512k would put the realistic profile at 5.1× turnover — deeper into
 *  saturation than the flood itself. See "Load profiles". */
const PROFILE_DEFAULT_RATE = {
  flood: 512 * 1024,
  realistic: 16 * 1024,
};

/** Smallest rate that still produces a load. Below this the flood's `head -c`
 *  goes to 1 byte and, at rate 0, `realisticBurst` divides by zero and emits
 *  `sleep Infinity` — a tab that outputs nothing, a run that measures nothing,
 *  and a summary that looks like any other. Reject rather than clamp: a typo'd
 *  rate is a mistake to surface, not a load to invent. */
const MIN_RATE_BYTES_PER_SEC = 64;

/** Parse `512k` / `2M` / `1024` into bytes per second. */
function parseRate(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(text);
  if (!match) throw new Error(`Bad --rate '${text}' (expected e.g. 512k, 2M, 4096)`);
  const mult = { k: 1024, K: 1024, m: 1024 ** 2, M: 1024 ** 2, '': 1 }[match[2]];
  const rate = Math.round(Number(match[1]) * mult);
  if (rate < MIN_RATE_BYTES_PER_SEC) {
    throw new Error(
      `--rate '${text}' resolves to ${rate} B/s, below the ${MIN_RATE_BYTES_PER_SEC} B/s floor. ` +
        `A rate this low emits no measurable load (at 0 it emits 'sleep Infinity' and nothing at all).`,
    );
  }
  return rate;
}

/** Parse `60s` / `2m` / `90` into milliseconds. */
function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([smSM]?)$/.exec(text);
  if (!match) throw new Error(`Bad --duration '${text}' (expected e.g. 60s, 2m)`);
  const mult = { s: 1000, S: 1000, m: 60_000, M: 60_000, '': 1000 }[match[2]];
  return Math.round(Number(match[1]) * mult);
}

function parseArgs(argv) {
  const args = {
    tabs: 8,
    profile: 'flood',
    // Null until every flag is read, then resolved from the profile. Defaulting
    // it up front would make `--rate` indistinguishable from its own default, so
    // `--profile realistic` could not pick a different one without silently
    // overriding an explicit `--rate` that happened to be parsed first.
    rate: null,
    durationMs: parseDuration('60s'),
    logging: 'on',
    traceGc: true,
    ab: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--tabs':
        args.tabs = Number.parseInt(value, 10);
        i++;
        break;
      case '--profile':
        if (!Object.hasOwn(PROFILE_DEFAULT_RATE, value)) {
          throw new Error(
            `Bad --profile '${value}' (expected 'flood' or 'realistic')`,
          );
        }
        args.profile = value;
        i++;
        break;
      case '--rate':
        args.rate = parseRate(value);
        i++;
        break;
      case '--duration':
        args.durationMs = parseDuration(value);
        i++;
        break;
      case '--logging':
        args.logging = value === 'off' ? 'off' : 'on';
        i++;
        break;
      case '--no-trace-gc':
        args.traceGc = false;
        break;
      case '--ab':
        args.ab = true;
        break;
      case '--force':
        args.force = true;
        break;
      default:
        // Rejected, never ignored. `--profile=realistic` already threw, but a
        // bare `node scripts/perf-load.mjs realistic` used to be SILENTLY
        // dropped and ran the default flood — the one regime whose whole
        // documented property is that it measures zero for the optimisation
        // under study. The most likely typo reinstating the exact bug the
        // profile flag exists to fix is not a defensible default.
        throw new Error(
          flag.startsWith('--')
            ? `Unknown flag ${flag}`
            : `Unexpected argument '${flag}' — every option is a flag, e.g. --profile ${flag}`,
        );
    }
  }
  if (!Number.isInteger(args.tabs) || args.tabs < 1) throw new Error('--tabs must be a positive int');
  args.rate ??= PROFILE_DEFAULT_RATE[args.profile];
  return args;
}

/** Available memory (bytes). Prefers MemAvailable, which unlike `freemem()`
 *  accounts for reclaimable page cache and is what the kernel itself uses to
 *  decide whether an allocation can be satisfied. */
async function availableBytes() {
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
    if (match) return Number(match[1]) * 1024;
  } catch {
    /* not Linux, or /proc unavailable — fall back */
  }
  return freemem();
}

/**
 * Refuse a run the machine plausibly cannot absorb.
 *
 * The audit documented this exact machine dying to memory pressure with five
 * agent tabs live, and the project notes flagged that staging an 8-tab flood
 * risked reproducing the very condition under study. A harness that can take the
 * user's session down is not a measuring instrument.
 */
async function assertMemorySafe({ tabs, force }) {
  const available = await availableBytes();
  const needed = tabs * EST_TAB_BYTES + RESERVE_BYTES;
  const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)}G`;
  console.log(
    `[perf-load] memory: ${gb(available)} available of ${gb(totalmem())}, ` +
      `plan needs ~${gb(needed)} for ${tabs} tabs`,
  );

  const problems = [];
  if (tabs > MAX_TABS_UNFORCED) problems.push(`--tabs ${tabs} exceeds the ${MAX_TABS_UNFORCED}-tab ceiling`);
  if (needed > available) problems.push(`plan needs ~${gb(needed)} but only ${gb(available)} is available`);
  if (problems.length === 0) return;

  const detail = problems.join('; ');
  if (!force) {
    throw new Error(
      `refusing to run: ${detail}.\n` +
        `  This machine's documented failure mode is systemd-oomd killing tabs at MemoryHigh under\n` +
        `  whole-machine pressure — which per-tab caps do NOT prevent. Close some tabs, lower --tabs,\n` +
        `  or pass --force if you accept the risk of losing the session.`,
    );
  }
  console.warn(`[perf-load] WARNING: ${detail} — proceeding because --force was given.`);
}

/**
 * `--profile flood`: a shell one-liner that emits `rate` bytes/second in small
 * chunks until killed. UNCHANGED since it was written — the realistic profile
 * was added beside it, not in place of it, because worst-case saturation is
 * still the right instrument for stressing the byte path.
 *
 * Deliberately many small writes rather than a few big ones: the per-chunk costs
 * (the OSC scan, the flow controller's batching decision, the logger's parse) are
 * what the audit ranked, and a handful of huge writes would amortise exactly the
 * thing being measured. 64 chunks/second approximates a chatty agent.
 *
 * KNOWN LIMITATION 1 — process creation. Each iteration forks `head`, `base64`,
 * `tr` and `sleep`, so the default 8 tabs drive ~2000 process creations/second.
 * A meaningful share of the load is therefore process creation rather than the
 * terminal byte path under study, which inflates the baseline in BOTH arms of the
 * logging A/B. The A/B delta stays interpretable (the fork cost is common to
 * both), but absolute constants read off this profile are upper bounds, not
 * measurements of the byte path alone. `--profile realistic` is the fix: its
 * lines are literals and `printf` is a builtin, so only the per-burst `sleep`
 * forks.
 *
 * KNOWN LIMITATION 2 — line shape, found 2026-07-23. `tr -d '\n'` collapses each
 * chunk into ONE line, which at the default rate is 10924 chars and wraps to 55
 * rows. Nothing a real program writes looks like this, and the row count it
 * produces (3.5× the whole log buffer per flush) puts the load in a regime no
 * real tab occupies. Not a defect in this profile — saturation is its job — but
 * it is why the flood cannot see a retention-dependent optimisation, and why
 * conclusions about one must be drawn from `--profile realistic`. Full
 * arithmetic in the header.
 */
function floodCommand(rate) {
  const chunkBytes = Math.max(1, Math.round(rate / FLOOD_CHUNKS_PER_SEC));
  // `head -c` from /dev/urandom then base64 keeps the bytes printable, so xterm
  // parses real text rather than discarding control junk.
  return (
    `while true; do head -c ${chunkBytes} /dev/urandom | base64 | tr -d '\\n'; echo; ` +
    `sleep ${(1 / FLOOD_CHUNKS_PER_SEC).toFixed(4)}; done`
  );
}

// ── `--profile realistic`
//
// Lines are drawn from a fixed pool that is built once and embedded in the
// command. Sizes chosen for the arithmetic in the header — do not tune one
// without redoing it.

/** Lines in the pool. Small on purpose — see `realisticCommand`. */
const REALISTIC_POOL_LINES = 24;
/** Shortest line. Lengths run over `[MIN, MIN + SPAN - 1]` = 80–120 chars: long
 *  enough to look like log output, and far enough under LOG_COLS (200) that a
 *  line is always exactly one grid row, which is what keeps rows proportional to
 *  bytes. */
const REALISTIC_LINE_MIN = 80;
const REALISTIC_LINE_SPAN = 41;
/** Stride through those 41 lengths. Coprime with SPAN, so 24 draws give 24
 *  DISTINCT lengths spread evenly across the band (mean 100.6) instead of a
 *  cluster — "varied, not fixed", and by construction rather than by luck. */
const REALISTIC_LINE_STRIDE = 37;
/** Target bursts per second. The only knob trading burstiness against forks:
 *  the per-burst `sleep` is the profile's sole fork, so halving this halves the
 *  fork rate and doubles the idle gap. 2/s gives ~2.2 bursts/s and ~0.45 s gaps
 *  at the default rate — clumpy like real output, and 114× fewer forks per tab
 *  per second than the flood (2.7× fewer per byte, the ratio that actually
 *  governs how much scheduler noise rides on each measured byte). */
const REALISTIC_BURSTS_PER_SEC = 2;
/** Fixed seed — see `makeRandom`. */
const REALISTIC_SEED = 0x5eed1e55;

const REALISTIC_LEVELS = ['INFO', 'DEBUG', 'WARN', 'TRACE', 'ERROR'];
const REALISTIC_MODULES = [
  'build/bundler',
  'build/assets',
  'test/runner',
  'test/fixtures',
  'watch/fs',
  'ipc/router',
  'git/status',
  'index/search',
  'term/session',
  'log/janitor',
];
const REALISTIC_WORDS = [
  'resolved', 'emitted', 'chunk', 'module', 'cached', 'skipped', 'rebuilt',
  'entry', 'bytes', 'in', 'ms', 'from', 'to', 'ok', 'pending', 'queued',
  'flushed', 'parsed', 'wrote', 'scanned', 'matched', 'stale', 'fresh',
  'batch', 'window', 'session', 'file', 'path', 'retry', 'done',
  'node_modules/pkg/dist', 'src/main/index.ts', 'src/renderer/app.tsx',
];

/**
 * xorshift32.
 *
 * Seeded and deterministic on purpose: both arms of an `--ab` run must see a
 * byte-identical load, or the delta being attributed to disk logging also
 * carries whatever the two draws happened to differ by. The flood profile reads
 * /dev/urandom and structurally cannot offer this; at its volumes the difference
 * averages out, but here it is free, so take it.
 */
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

const padNum = (value, width) => String(value).padStart(width, '0');

/**
 * One synthetic log line of EXACTLY `length` printable ASCII characters.
 *
 * Exactly, not approximately, and the last character is forced non-blank:
 * `translateToString(true)` trims trailing blanks per row, so a line ending in
 * whitespace renders shorter than it was written and drags the achieved rate
 * below the requested one — silently, since the harness would still report the
 * rate it asked for.
 *
 * The vocabulary contains no single quotes: these lines are embedded in the
 * command as POSIX single-quoted words. The longest possible prefix
 * (`[HH:MM:SS.mmm] LEVEL module:`) is 35 chars, comfortably under the 80-char
 * floor, so the fill loop always has room to run.
 */
function synthLogLine(length, random) {
  const stamp =
    `${padNum(random(24), 2)}:${padNum(random(60), 2)}:` +
    `${padNum(random(60), 2)}.${padNum(random(1000), 3)}`;
  const level = REALISTIC_LEVELS[random(REALISTIC_LEVELS.length)].padEnd(5);
  const mod = REALISTIC_MODULES[random(REALISTIC_MODULES.length)];
  let text = `[${stamp}] ${level} ${mod}:`;
  while (text.length < length) text += ` ${REALISTIC_WORDS[random(REALISTIC_WORDS.length)]}`;
  text = text.slice(0, length);
  return text.endsWith(' ') ? `${text.slice(0, -1)}.` : text;
}

/** The line pool. Deterministic, so every call returns the same array. */
function realisticLinePool() {
  const random = makeRandom(REALISTIC_SEED);
  const lines = [];
  for (let index = 0; index < REALISTIC_POOL_LINES; index++) {
    const length =
      REALISTIC_LINE_MIN + ((index * REALISTIC_LINE_STRIDE) % REALISTIC_LINE_SPAN);
    lines.push(synthLogLine(length, random));
  }
  return lines;
}

/**
 * Burst geometry for a requested `rate` — solved, not tuned.
 *
 * The pool's byte count is known exactly, so `repeats` follows from the target
 * burst cadence and the gap that yields `rate` follows from `repeats`. That is
 * why `effectiveRate` for this profile is the requested rate to the rounding of
 * one `sleep` argument, where the flood's is a third higher than requested.
 *
 * Caveat shared with the flood: emitting a burst takes time the fixed `sleep`
 * does not subtract, so the achieved rate is a ceiling approached from below.
 * The harness reports the bytes the app actually counted, so the drift is
 * visible rather than assumed.
 */
function realisticBurst(rate) {
  const pool = realisticLinePool();
  const poolBytes = pool.reduce((sum, line) => sum + line.length + 1, 0);
  const meanRowBytes = poolBytes / pool.length;
  const linesPerSec = rate / meanRowBytes;
  const repeats = Math.max(
    1,
    Math.round(linesPerSec / REALISTIC_BURSTS_PER_SEC / pool.length),
  );
  const burstBytes = repeats * poolBytes;
  return { pool, repeats, burstBytes, meanRowBytes, gapSec: burstBytes / rate };
}

/**
 * `--profile realistic`: short lines in bursts with idle gaps, at a rate that
 * leaves most of the log buffer frozen between flushes.
 *
 * Three deliberate differences from `floodCommand`:
 *
 * 1. SHORT LINES. 80–119 chars across 24 distinct lengths, so each is exactly
 *    one grid row and the row count tracks the byte count. The flood's single
 *    10924-char line wraps to 55 rows and makes the two diverge by 55×, which is
 *    most of how it saturates.
 *
 * 2. BURSTY, NOT STEADY. One burst is `repeats` passes over the pool written
 *    back-to-back, then a sleep — a build step, a test run, a pause. The flood's
 *    fixed 1/64 s cadence is a metronome no program produces.
 *
 * 3. ALMOST NO FORKING. Lines are literals and `printf` is a shell builtin, so
 *    the only fork is one `sleep` per burst: ~2.2/s/tab against the flood's 256,
 *    and 2.7× fewer per byte delivered. See `floodCommand` KNOWN LIMITATION 1.
 *
 * The pool is small and the whole command stays under ~2.6 KB ON PURPOSE. The
 * command string is stored as the session's `cmd` AND inside `argv`, and the
 * logger re-serialises that header on EVERY flush — so a command big enough to
 * hold a few seconds of non-repeating output would inject tens of KB of harness
 * artefact into the very write path being timed. Repetition across bursts is the
 * price, and it is the cheap side of that trade: xterm does not dedupe rows, so
 * repeated content costs exactly what fresh content would.
 *
 * POSIX shell only — `for`, `while`, `printf`, `[` and `$(( ))` are builtins in
 * bash and dash alike, and the tab runs under whatever `$SHELL` is (see
 * `defaultShell` in src/main/terminals.ts). One `printf` per line rather than one
 * per burst, because a real line-buffered program writes to its pty a line at a
 * time and batching them would amortise the per-chunk costs under study.
 */
function realisticCommand(rate) {
  const { pool, repeats, gapSec } = realisticBurst(rate);
  const words = pool.map((line) => `'${line}'`).join(' ');
  return (
    `while true; do n=0; while [ "$n" -lt ${repeats} ]; do ` +
    `for l in ${words}; do printf '%s\\n' "$l"; done; n=$((n+1)); done; ` +
    `sleep ${gapSec.toFixed(4)}; done`
  );
}

/** The shell one-liner for `profile` at `rate`. */
function loadCommand(profile, rate) {
  return profile === 'realistic' ? realisticCommand(rate) : floodCommand(rate);
}

/** Bytes/second the command would emit for a requested `rate` if every sleep
 *  were the only thing costing time — a NOMINAL CEILING, not a measurement.
 *
 *  `floodCommand` sizes its `head -c` in RAW bytes and then base64-encodes them,
 *  which expands 3 bytes to 4, plus a newline per chunk. Reporting the requested
 *  rate therefore understated the real load by about a third and gave the
 *  operator a wrong mental model of how hard the machine was being hit.
 *
 *  But it is a ceiling in BOTH profiles and always was: emitting a burst (and,
 *  for the flood, forking four processes per chunk) takes wall-clock the fixed
 *  `sleep` never subtracts, so the loop's real period is longer than its sleep.
 *  Measured 2026-07-23, a flood run printing a 682.8 KB/s ceiling delivered
 *  566 KB/s — 17 % low, which is the documented fork overhead showing up exactly
 *  where the arithmetic says it cannot. So this is labelled "nominal" wherever
 *  it is printed, and `summarise` checks the bytes the app actually counted
 *  against it. Between 2026-07-23 and that check, the label read "on the wire",
 *  which asserted delivery this function has no way to know about.
 *
 *  The realistic branch is `burstBytes / (burstBytes / rate)` — algebraically
 *  the identity `rate`, since `realisticBurst` SOLVES the gap for the requested
 *  rate rather than discovering it. It is kept in that form, rather than as
 *  `return rate`, only so the two profiles' ceilings are derived the same way
 *  and a future change to the burst geometry cannot drift them apart. Do not
 *  read it as a calculation that could have come out otherwise. */
function effectiveRate(profile, rate) {
  if (profile === 'realistic') {
    const { burstBytes, gapSec } = realisticBurst(rate);
    return Math.round(burstBytes / gapSec);
  }
  const chunkBytes = Math.max(1, Math.round(rate / FLOOD_CHUNKS_PER_SEC));
  return (Math.ceil(chunkBytes / 3) * 4 + 1) * FLOOD_CHUNKS_PER_SEC;
}

/** New grid rows a profile lands in one 5 s logger flush, per tab. The number
 *  the whole profile concept exists to control — compare it against
 *  `LOG_BUFFER_ROWS`. */
function rowsPerFlush(profile, rate) {
  const flushSec = LOG_FLUSH_MS / 1000;
  if (profile === 'realistic') {
    const { meanRowBytes } = realisticBurst(rate);
    return Math.round((rate / meanRowBytes) * flushSec);
  }
  const chunkBytes = Math.max(1, Math.round(rate / FLOOD_CHUNKS_PER_SEC));
  // One chunk is one very long line; xterm wraps it at LOG_COLS.
  const rowsPerChunk = Math.ceil((Math.ceil(chunkBytes / 3) * 4) / LOG_COLS);
  return Math.round(rowsPerChunk * FLOOD_CHUNKS_PER_SEC * flushSec);
}

/** Seconds this profile needs to fill the 5050-row buffer at `rate` — the point
 *  after which a grid render is walking a full buffer rather than a growing one.
 *  ~1.4 s for the flood at 512k, ~31 s for realistic at 16k. Every per-render
 *  figure taken before this is a different measurement from every one taken
 *  after; `summarise` uses it to keep the two apart. */
function saturationSec(profile, rate) {
  const rowsPerSec = rowsPerFlush(profile, rate) / (LOG_FLUSH_MS / 1000);
  return rowsPerSec > 0 ? LOG_BUFFER_ROWS / rowsPerSec : Infinity;
}

/** A percentage that never rounds to `0` or `100` unless it IS 0 or 100.
 *
 *  `toFixed(0)` on 99.98 gives "100", which under the sub-saturation branch of
 *  `reportRegime` printed "= 100% of it — the other 0% stays frozen and reusable
 *  between flushes": a run at effectively full turnover described as being in
 *  the reusable regime, i.e. precisely the plausible-but-wrong output that
 *  function exists to prevent. Widen the precision until the digits are honest
 *  rather than truncating them into a contradiction. */
function formatPercent(value) {
  for (const digits of [0, 1, 2, 3]) {
    const text = value.toFixed(digits);
    const rounded = Number(text);
    if (rounded === value || (rounded > 0 && rounded < 100)) return text;
  }
  return value.toFixed(4);
}

/**
 * Print which side of the log buffer this run lands on, before it starts.
 *
 * The entire point of `--profile` is the regime, and a run that does not state
 * its regime invites exactly the reading that produced the 2026-07-23 zero: a
 * plausible number, from a working harness, about a code path the load never
 * reached. Cheap to print, and it is the first thing to check against a
 * surprising result.
 *
 * Three bands, not two. The `>= 1` boundary is the real one — at or above it
 * nothing survives a flush — but a run just under it has a frozen prefix too
 * thin to reuse, and calling that "reusable" is only true in the sense that
 * makes it useless. Naming the near-saturation band stops the verdict reading as
 * an endorsement of a regime the operator almost certainly did not want.
 */
function reportRegime(profile, rate) {
  const rows = rowsPerFlush(profile, rate);
  const turnover = rows / LOG_BUFFER_ROWS;
  const percent = turnover * 100;
  let verdict;
  if (turnover >= 1) {
    verdict =
      `${turnover.toFixed(1)}x FULL TURNOVER — nothing survives a flush window, so a ` +
      `render-reuse optimisation cannot show up here by construction`;
  } else if (turnover >= 0.9) {
    verdict =
      `${formatPercent(percent)}% of it — only ${formatPercent(100 - percent)}% stays frozen, ` +
      `which is effectively saturation: reuse has almost nothing to work with here either`;
  } else {
    verdict =
      `${formatPercent(percent)}% of it — the other ` +
      `${formatPercent(100 - percent)}% stays frozen and reusable between flushes`;
  }
  console.log(
    `[perf-load] profile ${profile}: ~${rows} new rows per ` +
      `${LOG_FLUSH_MS / 1000}s flush against a ${LOG_BUFFER_ROWS}-row buffer = ${verdict}`,
  );
  if (turnover < 1) {
    console.log(
      `[perf-load] profile ${profile}: the buffer takes ~${saturationSec(profile, rate).toFixed(0)}s ` +
        `to saturate at this rate — windows before that are dropped from the steady-state ` +
        `ms/render, so a run must outlast it by several flushes to report one at all.`,
    );
  }
}

/**
 * Create the throwaway user-data dir + conception this run drives.
 *
 * Both live under /tmp and are removed afterwards. Nothing the harness does
 * reaches the user's real `~/.config/condash` or their conception — no settings
 * to restore, no logs to evict, no perf JSONL shared with a live instance.
 */
async function makeSandbox() {
  const root = await mkdtemp(join(tmpdir(), 'condash-perf-sandbox-'));
  const userDataDir = join(root, 'user-data');
  const conceptionPath = join(root, 'conception');
  // A conception is just a directory with these two trees; the harness only
  // needs somewhere for `.condash/` to land.
  await mkdir(userDataDir, { recursive: true });
  await mkdir(join(conceptionPath, 'projects'), { recursive: true });
  await mkdir(join(conceptionPath, 'knowledge'), { recursive: true });
  return { root, userDataDir, conceptionPath };
}

/** Run one load window end to end and return its perf records. */
/**
 * Warn when `src/` is newer than the bundles the run is about to measure.
 *
 * Existence is not currency, and the gap is not theoretical: on 2026-07-22 a
 * reading was taken against a `dist-electron/` seven weeks older than the tree,
 * so the run measured old code while reporting the current version back. The
 * preflight above would have passed it, and so would the renderer assertion — a
 * stale bundle mounts perfectly well.
 *
 * A warning rather than a throw: editing a source comment after building makes
 * the tree newer without changing what runs, and refusing to measure over that
 * would be worse than saying so. Naming the delta is what makes it actionable —
 * "42 days" reads very differently from "20 seconds".
 */
async function warnIfBuildStale(entries) {
  const newestSource = await newestMtime(join(repoRoot, 'src'));
  if (newestSource === 0) return;
  let oldestBundle = Infinity;
  for (const entry of entries) {
    oldestBundle = Math.min(oldestBundle, (await stat(entry)).mtimeMs);
  }
  if (newestSource <= oldestBundle) return;
  const staleMs = newestSource - oldestBundle;
  const age =
    staleMs > 86_400_000
      ? `${(staleMs / 86_400_000).toFixed(1)} days`
      : `${(staleMs / 60_000).toFixed(1)} min`;
  console.warn(
    `[perf-load] WARNING: src/ is ${age} newer than the built bundles. This run measures the ` +
      `BUILD, not the working tree — re-run \`npm run build\` unless that is what you want.`,
  );
}

/** Newest mtime under `dir`, recursively. 0 when the tree is unreadable. */
async function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtime(path));
    } else if (entry.isFile()) {
      newest = Math.max(newest, (await stat(path)).mtimeMs);
    }
  }
  return newest;
}

async function runWindow({ label, tabs, profile, rate, durationMs, logging, traceGc, sandbox }) {
  const outDir = join(OUT_DIR, label);
  await mkdir(outDir, { recursive: true });

  // Both halves of the build are prerequisites, and checking only the main one
  // actively misled: `npm run build` satisfied a main-only guard while the
  // renderer was still missing or stale, so the guard passed and the run
  // measured an app with no renderer at all. Name which half is missing.
  const mainEntry = join(repoRoot, 'dist-electron', 'main', 'index.js');
  const rendererEntry = join(repoRoot, 'dist', 'index.html');
  for (const [half, entry] of [
    ['main', mainEntry],
    ['renderer', rendererEntry],
  ]) {
    if (!existsSync(entry)) {
      throw new Error(`Missing ${half} bundle ${entry} — run \`npm run build\` first.`);
    }
  }
  await warnIfBuildStale([mainEntry, rendererEntry]);

  const gcLogPath = join(outDir, 'gc.log');
  const args = [mainEntry, `--user-data-dir=${sandbox.userDataDir}`];
  if (traceGc) args.push('--js-flags=--trace-gc');

  // "nominal ceiling", not "on the wire": `effectiveRate` is an upper bound the
  // loop approaches from below, and a flood run printing 682.8 KB/s here
  // delivered 566 KB/s. `summarise` prints what actually arrived.
  console.log(`[perf-load] ${label}: profile ${profile}, ${tabs} tabs, ` +
    `${(rate / 1024).toFixed(1)} KB/s each ` +
    `(nominal ceiling ~${(effectiveRate(profile, rate) / 1024).toFixed(1)} KB/s after encoding), ` +
    `${(durationMs / 1000).toFixed(0)}s, logging ${logging}, trace-gc ${traceGc}`);

  const app = await electron.launch({
    args,
    cwd: repoRoot,
    env: {
      ...process.env,
      // The conception override the main process honours (settings.ts) — this is
      // what keeps the flood's logs and perf records out of the user's real tree.
      CONDASH_CONCEPTION_PATH: sandbox.conceptionPath,
      // Load the built renderer, not the Vite dev server. `isDev` in
      // src/main/index.ts:187 is `!app.isPackaged && CONDASH_FORCE_PROD !== '1'`,
      // and this launch is unpackaged — so without this the app loads
      // http://localhost:5600, which only exists while `npm run dev` runs, and
      // comes up with a dead renderer. The Playwright fixture and
      // perf-baseline.mjs both set it for the same reason.
      CONDASH_FORCE_PROD: '1',
      // Isolation backstop, inert while CONDASH_FORCE_PROD is set: the dev
      // `app.setPath('userData', …)` redirect (index.ts:197) only runs when
      // `isDev`, so in forced-prod mode `--user-data-dir` alone carries the
      // isolation — verified 2026-07-22 by the runtime assertion below, which
      // reads the live path rather than trusting either mechanism. Kept so
      // dropping the prod force can never silently re-point the run at the
      // user's real settings.json.
      CONDASH_DEV_USER_DATA_DIR: sandbox.userDataDir,
    },
  });

  // Stream --trace-gc straight to disk. Buffering it in an array grew without
  // bound for the whole run, in the harness's own heap, on a machine the harness
  // is deliberately pushing toward memory pressure — and losing the harness took
  // every byte of GC evidence with it.
  //
  // BOTH streams: V8 writes --trace-gc to stdout, Electron writes its own
  // diagnostics to stderr, and capturing only stderr left gc.log holding twelve
  // lines of Electron noise and zero GC records on every run since the flag was
  // added. `gcRecords` counts what actually landed, so the run reports whether
  // GC was measured instead of the header comment asserting it.
  const gcStream = createWriteStream(gcLogPath);
  let gcRecords = 0;
  // A chunk boundary can fall mid-line, so carry the tail into the next chunk
  // rather than counting a split record twice or not at all.
  let gcPartialLine = '';
  const countGcRecords = (text) => {
    const lines = (gcPartialLine + text).split('\n');
    gcPartialLine = lines.pop() ?? '';
    for (const line of lines) if (GC_RECORD.test(line)) gcRecords++;
  };
  app.process().stdout?.on('data', (chunk) => {
    gcStream.write(chunk);
    countGcRecords(chunk.toString());
  });
  app.process().stderr?.on('data', (chunk) => {
    gcStream.write(chunk);
    // The app-scope backstop warns on stderr when it could not cap condash's own
    // scope, which is exactly the state a flood must not run in. Surface it
    // instead of burying it in gc.log.
    const text = chunk.toString();
    if (text.includes('app-scope backstop not applied')) {
      console.warn(`[perf-load] WARNING: ${text.trim()}`);
    }
  });

  try {
    // Assert the isolation actually took, in the MAIN process, before any load.
    // `--user-data-dir` is the documented Electron switch for this, but a silent
    // failure here would mean writing to the user's real settings.json — the
    // exact damage this design exists to prevent, so it gets a runtime check
    // rather than trust.
    const liveUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    if (!liveUserData.startsWith(sandbox.root)) {
      throw new Error(
        `isolation failed: app userData is '${liveUserData}', outside the sandbox '${sandbox.root}'. ` +
          `Refusing to run — this would mutate your real settings.json.`,
      );
    }
    console.log(`[perf-load] isolated: userData=${liveUserData}`);

    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Assert the RENDERER actually loaded, before any load — same posture as the
    // isolation assertion above, for the same reason: a silent failure here is a
    // plausible, invalid reading rather than a crash. A dev-mode launch points at
    // the Vite dev URL and, with no dev server up, leaves a chrome-error page.
    // Measured 2026-07-22, that dead renderer understated gridRenderMs by 26 %,
    // understated the logging A/B's loop-p99 delta by 9×, and reported
    // `pauses: 0` where the real path pauses 4 times — flow control cannot
    // engage when nothing consumes.
    //
    // The check is a MOUNTED #root, not the presence of `window.condash`: the
    // preload still runs on the error page, so every IPC call below succeeds
    // against a renderer that draws nothing. Presence of the API proves nothing.
    const pageUrl = window.url();
    try {
      await window.waitForSelector('#root > *', { timeout: 30_000 });
    } catch {
      throw new Error(
        `renderer did not load: page is '${pageUrl}', #root never gained a child. ` +
          `A chrome-error:// URL is the flagship case — the app booted in dev mode and the Vite ` +
          `server it wants is not running, so navigation failed outright (CONDASH_FORCE_PROD lost ` +
          `from the launch env). A localhost URL means dev mode with the server up but the app ` +
          `not mounting; a file:// URL means the built renderer bundle is broken or stale. ` +
          `Refusing to measure a dead renderer.`,
      );
    }
    console.log(`[perf-load] renderer loaded: ${pageUrl}`);

    // Configure through the app's own IPC rather than by writing settings.json
    // behind its back: the running process caches prefs, so a file edit would
    // not take effect and the A/B would silently compare identical states.
    await window.evaluate(
      async ([loggingOn]) => {
        // termSetPrefs REPLACES the whole terminal block rather than patching
        // it, so read-merge-write. Harmless here (sandboxed settings), but the
        // trap is real and this is the shape every caller must copy.
        const current = await window.condash.termGetPrefs();
        await window.condash.termSetPrefs({
          ...current,
          logging: { ...current.logging, enabled: loggingOn },
        });
        await window.condash.perfSetEnabled(true);
      },
      [logging === 'on'],
    );

    const command = loadCommand(profile, rate);
    const sids = await window.evaluate(
      async ([count, cmd]) => {
        const ids = [];
        for (let i = 0; i < count; i++) {
          const { id } = await window.condash.termSpawn({ side: 'my', command: cmd });
          ids.push(id);
        }
        return ids;
      },
      [tabs, command],
    );
    console.log(`[perf-load] ${label}: spawned ${sids.length} tabs, running…`);

    await window.waitForTimeout(durationMs);

    const vitals = await window.evaluate(async () => window.condash.perfVitals());
    console.log(
      `[perf-load] ${label}: loop p99 ${vitals.loop?.p99 ?? '—'} ms, ` +
        `max ${vitals.loop?.max ?? '—'} ms, heap ${(vitals.heapUsed / 1024 ** 2).toFixed(0)} MB`,
    );

    await window.evaluate(
      async ([ids]) => {
        for (const id of ids) await window.condash.termClose(id);
      },
      [sids],
    );

    return { vitals, sids };
  } finally {
    await app.close().catch(() => {});
    await new Promise((done) => gcStream.end(done));
    // Verify the GC evidence exists rather than assuming the flag produced it.
    // gc.log held zero records for every run between the flag being added and
    // 2026-07-22, because the harness captured the wrong stream — a silent hole
    // in the one signal that is invisible to every in-app counter.
    if (traceGc) {
      if (gcRecords === 0) {
        console.warn(
          `[perf-load] WARNING: ${label}: --trace-gc was on but ${gcLogPath} holds ZERO GC ` +
            `records. GC is UNMEASURED for this run — do not read a GC conclusion off it.`,
        );
      } else {
        console.log(`[perf-load] ${label}: ${gcRecords} GC records → ${gcLogPath}`);
      }
    }
  }
}

/** Read back the perf JSONL the app wrote for this run. */
async function readPerfRecords(conceptionPath) {
  const day = new Date().toISOString().slice(0, 10);
  const path = join(conceptionPath, '.condash', 'perf', `${day}.jsonl`);
  try {
    const text = await readFile(path, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Records this harness knows how to compare. See `PERF_SCHEMA_VERSION`. */
const EXPECTED_SCHEMA = 2;

/** Fewest post-saturation renders that may back a steady-state ms/render.
 *  One render per 5 s flush per tab, so a 60 s single-tab realistic run
 *  (saturating at ~31 s) yields about six — the figure is reported, and below
 *  this it is refused outright rather than published from two samples. */
const MIN_STEADY_RENDERS = 4;
/** …and fewest post-saturation windows, so a single fat window cannot stand in
 *  for a series. Records land on the app's 2.5 s sampler tick. */
const MIN_STEADY_WINDOWS = 3;

/** Fraction of the nominal ceiling below which the delivered byte count is
 *  reported as a divergence rather than a rounding difference. The flood's
 *  documented fork overhead lands it around 0.83, so this is deliberately below
 *  that: the point is to catch a load that did not run, not to relitigate a
 *  known and explained shortfall on every invocation. */
const DELIVERY_FLOOR = 0.7;
/** …and the ceiling. `effectiveRate` is an upper bound by construction, so
 *  exceeding it means the model is wrong, not that the run went well. */
const DELIVERY_CEILING = 1.05;

/** Sum the per-session counters of one window into `totals`, in place. */
function accumulate(totals, record) {
  for (const session of Object.values(record.sessions)) {
    totals.bytes += session.bytes ?? 0;
    totals.oscMs += session.oscMs ?? 0;
    totals.logParseMs += session.logParseMs ?? 0;
    totals.gridRenderMs += session.gridRenderMs ?? 0;
    totals.gridRenders += session.gridRenders ?? 0;
    totals.batches += session.batches ?? 0;
    totals.pauses += session.pauses ?? 0;
    totals.watchdogs += session.watchdogs ?? 0;
  }
}

const emptyTotals = () => ({
  bytes: 0,
  oscMs: 0,
  logParseMs: 0,
  gridRenderMs: 0,
  gridRenders: 0,
  batches: 0,
  pauses: 0,
  watchdogs: 0,
});

/**
 * Split the run's windows at the moment the log buffer fills.
 *
 * A grid render costs O(retained buffer size), so a render taken while the
 * buffer is still filling is measuring a smaller object than one taken after.
 * Averaging the two is not noise — it is a systematic bias, and it runs in the
 * direction that flatters whichever profile saturates faster. The flood fills in
 * ~1.4 s and so is essentially all steady state; `realistic` at 16k needs ~31 s,
 * so a 45-60 s run spends a third to half its renders on an unsaturated buffer.
 *
 * Measured 2026-07-23, `--tabs 1 --duration 60s`, with this split in place:
 * whole-run 49.06 ms flood vs 8.68 realistic reads as 5.65x, where steady state
 * (53.52 / 11.71) reads as 4.57x — a 24 % overstatement manufactured entirely by
 * the average. At 120 s the same pair gives 51.71 / 9.64 = 5.36x whole-run
 * against 53.96 / 10.80 = 5.00x steady, so the bias shrinks with duration
 * without ever going away, which is exactly why it cannot be outrun instead of
 * fixed. The review that found this measured 6.45x against 4.6x at 45 s.
 *
 * A window counts as steady only if it STARTED after saturation, so no window
 * straddles the boundary.
 *
 * @returns the steady-state window subset, plus the run start it measured from.
 */
function steadyWindows(records, profile, rate) {
  const windowStart = (record) => Date.parse(record.t) - record.windowMs;
  const runStart = Math.min(...records.map(windowStart));
  const saturatedAt = runStart + saturationSec(profile, rate) * 1000;
  return { runStart, saturatedAt, windows: records.filter((r) => windowStart(r) >= saturatedAt) };
}

/** Aggregate the per-window records into the numbers the audit asked for.
 *
 *  Records are dropped rather than averaged when their schema does not match:
 *  v4.96.0 wrote `loop` values carrying a fixed ~10 ms offset, and because the
 *  JSONL is one file per day, an upgrade mid-day leaves both meanings in one
 *  file. Silently mixing them would shift an A/B by more than the effect it is
 *  trying to measure. */
function summarise(records, { profile, rate, tabs, durationMs }) {
  const usable = records.filter((r) => r.schema === EXPECTED_SCHEMA);
  const skipped = records.length - usable.length;
  if (skipped > 0) {
    console.warn(
      `[perf-load] skipped ${skipped} record(s) not at schema ${EXPECTED_SCHEMA} ` +
        `— pre-v4.97 loop values are offset by the sampler resolution and are not comparable.`,
    );
  }
  records = usable;
  if (records.length === 0) return null;
  const loopP99 = records.map((r) => r.loop.p99).sort((a, b) => a - b);
  const totals = emptyTotals();
  for (const record of records) accumulate(totals, record);

  const { saturatedAt, runStart, windows: steady } = steadyWindows(records, profile, rate);
  const steadyTotals = emptyTotals();
  for (const record of steady) accumulate(steadyTotals, record);
  const steadyEnough =
    steady.length >= MIN_STEADY_WINDOWS && steadyTotals.gridRenders >= MIN_STEADY_RENDERS;
  if (!steadyEnough) {
    console.warn(
      `[perf-load] WARNING: NO STEADY-STATE ms/render for this run. The ${LOG_BUFFER_ROWS}-row ` +
        `buffer saturates ~${saturationSec(profile, rate).toFixed(0)}s in, leaving ` +
        `${steady.length} window(s) and ${steadyTotals.gridRenders} render(s) after it (need ` +
        `>=${MIN_STEADY_WINDOWS} and >=${MIN_STEADY_RENDERS}). A render costs O(retained buffer), ` +
        `so the whole-run figure below MIXES a filling buffer with a full one and reads low — do ` +
        `not quote it as a per-render cost, and do not compare it across profiles. Re-run longer.`,
    );
  }

  // The nominal ceiling is what `effectiveRate` can know; this is what arrived.
  // Without the comparison a broken one-liner — a quoting slip, a shell without
  // the builtin, a rate typo — exits 0 behind a plausible-looking summary.
  const expectedBytes = (effectiveRate(profile, rate) * tabs * durationMs) / 1000;
  const deliveredFraction = expectedBytes > 0 ? totals.bytes / expectedBytes : null;
  if (deliveredFraction !== null && (deliveredFraction < DELIVERY_FLOOR || deliveredFraction > DELIVERY_CEILING)) {
    console.warn(
      `[perf-load] WARNING: delivered ${(totals.bytes / 1024 ** 2).toFixed(1)} MB against a nominal ` +
        `${(expectedBytes / 1024 ** 2).toFixed(1)} MB (${(deliveredFraction * 100).toFixed(0)}% of ` +
        `ceiling). Outside ${(DELIVERY_FLOOR * 100).toFixed(0)}-${(DELIVERY_CEILING * 100).toFixed(0)}%, ` +
        `so the load is not the one requested — check the generated command actually runs under ` +
        `the tab's $SHELL before reading anything else off this run.`,
    );
  }

  return {
    // Carried so summary.json says which regime produced it. Two runs of this
    // harness can differ by 32× in rate and 22× in rows per flush and otherwise
    // look identical on disk.
    profile,
    rateBytesPerSec: rate,
    // NOMINAL — an upper bound the loop approaches from below, never a
    // measurement. `deliveredFractionOfNominal` is what actually arrived.
    nominalRateBytesPerSec: effectiveRate(profile, rate),
    rowsPerFlush: rowsPerFlush(profile, rate),
    bufferRows: LOG_BUFFER_ROWS,
    saturationSec: Number(saturationSec(profile, rate).toFixed(1)),
    windows: records.length,
    loopP99Median: loopP99[Math.floor(loopP99.length / 2)],
    loopMaxObserved: Math.max(...records.map((r) => r.loop.max)),
    ...totals,
    deliveredFractionOfNominal:
      deliveredFraction === null ? null : Number(deliveredFraction.toFixed(3)),
    // ── The headline. gridRenderMs fires once per 5 s flush and costs
    // O(retained buffer), so it does NOT scale with bytes — totalling it
    // compares two runs' flush COUNTS as much as their render costs, and per
    // render is the only normalisation that reads across profiles.
    //
    // But per render over the WHOLE run is not that normalisation either: it
    // averages every warming-buffer render in with every full-buffer one, and
    // the two profiles warm at very different speeds (~1.4 s vs ~31 s), so the
    // bias does not cancel between them. Steady state is the comparable figure;
    // the whole-run one is kept beside it, named for what it is.
    gridRenderMsPerRenderSteady:
      steadyEnough ? steadyTotals.gridRenderMs / steadyTotals.gridRenders : null,
    steadyWindows: steady.length,
    steadyRenders: steadyTotals.gridRenders,
    steadyGridRenderMs: steadyTotals.gridRenderMs,
    steadyFromSecIntoRun: Number(((saturatedAt - runStart) / 1000).toFixed(1)),
    /** Whole-run mean, warm-up included. Biased low, kept for continuity. */
    gridRenderMsPerRenderAllWindows:
      totals.gridRenders > 0 ? totals.gridRenderMs / totals.gridRenders : null,
    // The question the audit could not answer from source: of the main-thread
    // time attributable to the byte path, how is it split?
    oscShareOfMeasured:
      totals.oscMs + totals.logParseMs + totals.gridRenderMs > 0
        ? totals.oscMs / (totals.oscMs + totals.logParseMs + totals.gridRenderMs)
        : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertMemorySafe(args);
  reportRegime(args.profile, args.rate);

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const sandbox = await makeSandbox();
  console.log(`[perf-load] sandbox: ${sandbox.root}`);
  const conceptionPath = sandbox.conceptionPath;

  // Ctrl-C skips `finally`, so without this the sandbox is left behind under
  // /tmp on the one exit path an operator is most likely to take when a load
  // run misbehaves.
  const cleanUpAndExit = () => {
    rmSync(sandbox.root, { recursive: true, force: true });
    process.exit(130);
  };
  process.once('SIGINT', cleanUpAndExit);
  process.once('SIGTERM', cleanUpAndExit);

  const modes = args.ab ? ['on', 'off'] : [args.logging];
  const summary = {};

  try {
    for (const logging of modes) {
      const label = `logging-${logging}`;
      const before = (await readPerfRecords(conceptionPath)).length;
      await runWindow({ ...args, logging, label, sandbox });
      const records = (await readPerfRecords(conceptionPath)).slice(before);
      await writeFile(
        join(OUT_DIR, label, 'perf.jsonl'),
        records.map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8',
      );
      summary[label] = summarise(records, {
        profile: args.profile,
        rate: args.rate,
        tabs: args.tabs,
        durationMs: args.durationMs,
      });
    }
  } finally {
    // Results already live under OUT_DIR; the sandbox itself is disposable.
    await rm(sandbox.root, { recursive: true, force: true }).catch(() => {});
  }

  await writeFile(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n[perf-load] summary → ${join(OUT_DIR, 'summary.json')}`);
  for (const [label, stats] of Object.entries(summary)) {
    if (!stats) {
      console.log(`  ${label}: no records (was recording enabled?)`);
      continue;
    }
    // Steady state first and whole-run beside it, both labelled, and the sample
    // count in view — "4.6x from 6 renders" is a very different claim from
    // "4.6x", and the reader should not have to open summary.json to tell.
    const steady =
      stats.gridRenderMsPerRenderSteady === null
        ? `NOT MEASURED (only ${stats.steadyRenders} render(s) after saturation)`
        : `${stats.gridRenderMsPerRenderSteady.toFixed(2)} ms/render over ${stats.steadyRenders} ` +
          `renders from ${stats.steadyFromSecIntoRun}s in`;
    const allWindows =
      stats.gridRenderMsPerRenderAllWindows === null
        ? '—'
        : `${stats.gridRenderMsPerRenderAllWindows.toFixed(2)} ms/render`;
    console.log(
      `  ${label} [${stats.profile}]: loop p99 median ${stats.loopP99Median} ms, ` +
        `max ${stats.loopMaxObserved} ms, bytes ${(stats.bytes / 1024 ** 2).toFixed(1)} MB ` +
        `(${((stats.deliveredFractionOfNominal ?? 0) * 100).toFixed(0)}% of nominal), ` +
        `osc ${stats.oscMs.toFixed(0)} ms, logParse ${stats.logParseMs.toFixed(0)} ms, ` +
        `gridRender ${stats.gridRenderMs.toFixed(0)} ms over ${stats.gridRenders} renders, ` +
        `pauses ${stats.pauses}, watchdogs ${stats.watchdogs}`,
    );
    console.log(`      steady state: ${steady}   |   whole run incl. warm-up: ${allWindows}`);
  }
  if (args.ab && summary['logging-on'] && summary['logging-off']) {
    const delta = summary['logging-on'].loopP99Median - summary['logging-off'].loopP99Median;
    console.log(
      `\n[perf-load] F5 verdict: disk logging costs ${delta.toFixed(2)} ms of main-loop p99 ` +
        `at ${args.tabs} tabs.`,
    );
  }
}

// Run only when invoked as a script. The guard is what lets
// `terminal-logger-harness-mirror.test.ts` import LOGGER_GEOMETRY_MIRROR and
// compare it against the logger's own constants — without it, importing this
// module would launch Electron and stage a flood inside the unit suite.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[perf-load]', err);
    process.exit(1);
  });
}
