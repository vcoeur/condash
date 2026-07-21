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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const OUT_DIR = '/tmp/perf-load';

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
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown flag ${flag}`);
    }
  }
  if (!Number.isInteger(args.tabs) || args.tabs < 1) throw new Error('--tabs must be a positive int');
  return args;
}

/**
 * A shell one-liner that emits `rate` bytes/second in small chunks until killed.
 *
 * Deliberately many small writes rather than a few big ones: the per-chunk costs
 * (the OSC scan, the flow controller's batching decision, the logger's parse) are
 * what the audit ranked, and a handful of huge writes would amortise exactly the
 * thing being measured. 64 chunks/second approximates a chatty agent.
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

/** Run one load window end to end and return its perf records. */
async function runWindow({ label, tabs, rate, durationMs, logging, traceGc }) {
  const outDir = join(OUT_DIR, label);
  await mkdir(outDir, { recursive: true });

  const mainEntry = join(repoRoot, 'dist-electron', 'main', 'index.js');
  if (!existsSync(mainEntry)) {
    throw new Error(`Missing ${mainEntry} — run \`npm run build\` first.`);
  }

  const gcLogPath = join(outDir, 'gc.log');
  const args = [mainEntry];
  if (traceGc) args.push('--js-flags=--trace-gc');

  console.log(`[perf-load] ${label}: ${tabs} tabs, ${(rate / 1024).toFixed(0)} KB/s each, ` +
    `${(durationMs / 1000).toFixed(0)}s, logging ${logging}, trace-gc ${traceGc}`);

  const app = await electron.launch({ args, cwd: repoRoot });
  const gcChunks = [];
  app.process().stderr?.on('data', (chunk) => gcChunks.push(chunk.toString()));

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Configure through the app's own IPC rather than by writing settings.json
    // behind its back: the running process caches prefs, so a file edit would
    // not take effect and the A/B would silently compare identical states.
    await window.evaluate(
      async ([loggingOn]) => {
        // termSetPrefs REPLACES the whole terminal block rather than patching
        // it, so read-merge-write: a bare { logging } would wipe the shell,
        // shortcuts, and memory caps out of the user's settings.json.
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
    if (gcChunks.length > 0) await writeFile(gcLogPath, gcChunks.join(''), 'utf8');
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

/** Aggregate the per-window records into the numbers the audit asked for. */
function summarise(records) {
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
  const conceptionPath = process.env.CONDASH_CONCEPTION_PATH ?? '/home/alice/src/vcoeur/conception';
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const modes = args.ab ? ['on', 'off'] : [args.logging];
  const summary = {};

  for (const logging of modes) {
    const label = `logging-${logging}`;
    const before = (await readPerfRecords(conceptionPath)).length;
    await runWindow({ ...args, logging, label });
    const records = (await readPerfRecords(conceptionPath)).slice(before);
    await writeFile(
      join(OUT_DIR, label, 'perf.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
    summary[label] = summarise(records);
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
