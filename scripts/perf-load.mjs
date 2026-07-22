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
// Output:
//   /tmp/perf-load/<label>/perf.jsonl    per-window counter records
//   /tmp/perf-load/<label>/gc.log        raw --trace-gc output
//   /tmp/perf-load/summary.json          parsed comparison across labels
//
// Usage:
//   node scripts/perf-load.mjs --tabs 8 --rate 512k --duration 60s
//   node scripts/perf-load.mjs --tabs 8 --rate 512k --duration 60s --logging off
//   node scripts/perf-load.mjs --ab            # runs logging on AND off, compares

import { _electron as electron } from 'playwright';
import { createWriteStream, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/** Parse `512k` / `2M` / `1024` into bytes per second. */
function parseRate(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(text);
  if (!match) throw new Error(`Bad --rate '${text}' (expected e.g. 512k, 2M, 4096)`);
  const mult = { k: 1024, K: 1024, m: 1024 ** 2, M: 1024 ** 2, '': 1 }[match[2]];
  return Math.round(Number(match[1]) * mult);
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
    rate: parseRate('512k'),
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
        if (flag.startsWith('--')) throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!Number.isInteger(args.tabs) || args.tabs < 1) throw new Error('--tabs must be a positive int');
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
 * A shell one-liner that emits `rate` bytes/second in small chunks until killed.
 *
 * Deliberately many small writes rather than a few big ones: the per-chunk costs
 * (the OSC scan, the flow controller's batching decision, the logger's parse) are
 * what the audit ranked, and a handful of huge writes would amortise exactly the
 * thing being measured. 64 chunks/second approximates a chatty agent.
 *
 * KNOWN LIMITATION: each iteration forks `head`, `base64`, `tr` and `sleep`, so
 * the default 8 tabs drive ~2000 process creations/second. A meaningful share of
 * the load is therefore process creation rather than the terminal byte path
 * under study, which inflates the baseline in BOTH arms of the logging A/B. The
 * A/B delta stays interpretable (the fork cost is common to both), but absolute
 * constants read off this harness are upper bounds, not measurements of the byte
 * path alone. Generating the bytes in-process would fix it.
 */
function floodCommand(rate) {
  const chunksPerSec = 64;
  const chunkBytes = Math.max(1, Math.round(rate / chunksPerSec));
  // `head -c` from /dev/urandom then base64 keeps the bytes printable, so xterm
  // parses real text rather than discarding control junk.
  return (
    `while true; do head -c ${chunkBytes} /dev/urandom | base64 | tr -d '\\n'; echo; ` +
    `sleep ${(1 / chunksPerSec).toFixed(4)}; done`
  );
}

/** Bytes/second actually emitted for a requested `rate`.
 *
 *  `floodCommand` sizes its `head -c` in RAW bytes and then base64-encodes them,
 *  which expands 3 bytes to 4, plus a newline per chunk. Reporting the requested
 *  rate therefore understated the real load by about a third and gave the
 *  operator a wrong mental model of how hard the machine was being hit. */
function effectiveRate(rate) {
  const chunksPerSec = 64;
  const chunkBytes = Math.max(1, Math.round(rate / chunksPerSec));
  return (Math.ceil(chunkBytes / 3) * 4 + 1) * chunksPerSec;
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
async function runWindow({ label, tabs, rate, durationMs, logging, traceGc, sandbox }) {
  const outDir = join(OUT_DIR, label);
  await mkdir(outDir, { recursive: true });

  const mainEntry = join(repoRoot, 'dist-electron', 'main', 'index.js');
  if (!existsSync(mainEntry)) {
    throw new Error(`Missing ${mainEntry} — run \`npm run build\` first.`);
  }

  const gcLogPath = join(outDir, 'gc.log');
  const args = [mainEntry, `--user-data-dir=${sandbox.userDataDir}`];
  if (traceGc) args.push('--js-flags=--trace-gc');

  console.log(`[perf-load] ${label}: ${tabs} tabs, ${(rate / 1024).toFixed(0)} KB/s each ` +
    `(~${(effectiveRate(rate) / 1024).toFixed(0)} KB/s after base64), ` +
    `${(durationMs / 1000).toFixed(0)}s, logging ${logging}, trace-gc ${traceGc}`);

  const app = await electron.launch({
    args,
    cwd: repoRoot,
    env: {
      ...process.env,
      // The conception override the main process honours (settings.ts) — this is
      // what keeps the flood's logs and perf records out of the user's real tree.
      CONDASH_CONCEPTION_PATH: sandbox.conceptionPath,
      // BOTH overrides are needed, and the runtime assertion below is why we
      // know it: `--user-data-dir` alone is silently overridden, because a dev
      // launch calls `app.setPath('userData', …)` at module top level to keep
      // `npm run dev` from racing the installed app for settings.json. This env
      // var is that redirect's own escape hatch.
      CONDASH_DEV_USER_DATA_DIR: sandbox.userDataDir,
    },
  });

  // Stream --trace-gc straight to disk. Buffering it in an array grew without
  // bound for the whole run, in the harness's own heap, on a machine the harness
  // is deliberately pushing toward memory pressure — and losing the harness took
  // every byte of GC evidence with it.
  const gcStream = createWriteStream(gcLogPath);
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

    const command = floodCommand(rate);
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

/** Aggregate the per-window records into the numbers the audit asked for.
 *
 *  Records are dropped rather than averaged when their schema does not match:
 *  v4.96.0 wrote `loop` values carrying a fixed ~10 ms offset, and because the
 *  JSONL is one file per day, an upgrade mid-day leaves both meanings in one
 *  file. Silently mixing them would shift an A/B by more than the effect it is
 *  trying to measure. */
function summarise(records) {
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
  const totals = { bytes: 0, oscMs: 0, logParseMs: 0, gridRenderMs: 0, batches: 0, pauses: 0, watchdogs: 0 };
  for (const record of records) {
    for (const session of Object.values(record.sessions)) {
      totals.bytes += session.bytes ?? 0;
      totals.oscMs += session.oscMs ?? 0;
      totals.logParseMs += session.logParseMs ?? 0;
      totals.gridRenderMs += session.gridRenderMs ?? 0;
      totals.batches += session.batches ?? 0;
      totals.pauses += session.pauses ?? 0;
      totals.watchdogs += session.watchdogs ?? 0;
    }
  }
  return {
    windows: records.length,
    loopP99Median: loopP99[Math.floor(loopP99.length / 2)],
    loopMaxObserved: Math.max(...records.map((r) => r.loop.max)),
    ...totals,
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
      summary[label] = summarise(records);
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
    console.log(
      `  ${label}: loop p99 median ${stats.loopP99Median} ms, max ${stats.loopMaxObserved} ms, ` +
        `osc ${stats.oscMs.toFixed(0)} ms, logParse ${stats.logParseMs.toFixed(0)} ms, ` +
        `gridRender ${stats.gridRenderMs.toFixed(0)} ms, pauses ${stats.pauses}, ` +
        `watchdogs ${stats.watchdogs}`,
    );
  }
  if (args.ab && summary['logging-on'] && summary['logging-off']) {
    const delta = summary['logging-on'].loopP99Median - summary['logging-off'].loopP99Median;
    console.log(
      `\n[perf-load] F5 verdict: disk logging costs ${delta.toFixed(2)} ms of main-loop p99 ` +
        `at ${args.tabs} tabs.`,
    );
  }
}

main().catch((err) => {
  console.error('[perf-load]', err);
  process.exit(1);
});
