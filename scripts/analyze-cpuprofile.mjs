#!/usr/bin/env node
// Rank a V8/CDP `.cpuprofile` by self-time per function.
//
// Written 2026-07-23 for the renderer trace `scripts/perf-load.mjs
// --renderer-profile` produces, to answer the 2026-07-21 audit's open renderer
// question (note 04): under a multi-tab flood, which stage dominates the renderer
// MAIN thread — OSC/ANSI parse (xterm write), the F8 structured-clone double copy
// (IPC deserialize + worker postMessage), or something the audit did not name?
// That is a self-time question — time a function spent on TOP of the stack — so
// this is the reduction it needs, kept as a committed helper because reading a
// `.cpuprofile` by eye does not scale and every future renderer trace wants the
// same ranking.
//
// Self-time, not total time: each entry in `profile.samples` is the node
// executing at that tick and `profile.timeDeltas[i]` (microseconds) is the gap to
// the next tick, so summing timeDeltas per top node and grouping by its callFrame
// is exactly Chrome DevTools' "Self time" column. `hitCount` (samples on top) is
// reported beside it as a cross-check; the two agree up to sampling jitter.
//
// V8 folds non-JS time into synthetic nodes — `(idle)` (thread parked),
// `(program)` (VM work not tied to a JS frame, where native structured-clone and
// postMessage cost tends to surface), `(garbage collector)`, `(root)`. They are
// reported as their own line so an all-idle trace (profiler attached to a page
// the load never reached) is obvious rather than hidden.
//
// Usage: node scripts/analyze-cpuprofile.mjs <file.cpuprofile> [--top N]

import { readFileSync } from 'node:fs';

const SYNTHETIC = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);

/** Coarse stage buckets for the audit's question. Matched against the function
 *  name and url in order; first hit wins. Deliberately conservative — a frame
 *  that matches nothing lands in `other`, which is reported, not silently
 *  absorbed. */
// ORDER MATTERS — first hit wins, and two of these buckets live in the SAME
// minified xterm bundle, so a URL-only test cannot separate them. The
// SerializeAddon (F7's main-thread demote-serialize) and the ANSI parser/renderer
// both resolve to `xterm-mount-*.js`; only the retained function names tell them
// apart, so the name-based SerializeAddon bucket MUST precede the URL-based parse
// bucket. Putting parse first (as an earlier version did) stamped the whole
// bundle "parse" and folded ~1.4 s of F7 serialize into it — hiding that F7 has a
// real main-thread cost, larger than F8's. `clone` (BufferLine.clone, on the
// scroll path) is genuinely parse-side and is deliberately NOT in the serialize
// set, so it still lands in parse.
//
// This relies on those SerializeAddon symbol names surviving the build; if a
// future bundle mangles them, the serialize frames fall back into parse (an
// over-count of parse, never a mislabel of F8) — flagged here so the next reader
// re-checks rather than trusts.
const STAGES = [
  { stage: 'xterm SerializeAddon (F7 demote-serialize)', test: (name, url) => /xterm/i.test(url) && /(^|\b)serialize|_serializeBuffer|_nextCell|_diffStyle|attributesEquals/i.test(name) },
  { stage: 'xterm parse + render (ANSI/OSC write)', test: (name, url) => /xterm|InputHandler|EscapeSequenceParser|_parse|WriteBuffer|Terminal\b/.test(name) || /xterm/i.test(url) },
  { stage: 'structured clone / postMessage (F8, send side)', test: (name, url) => !/xterm/i.test(url) && /postMessage|structuredClone|deserialize|Serializer/i.test(name) },
  { stage: 'IPC / termData dispatch', test: (name, url) => /onTermData|ipcRenderer|emit|dispatch|termData/i.test(name) || /preload/i.test(url) },
  { stage: 'worker manager (write/serialize RPC)', test: (name, url) => /terminal-worker|worker/i.test(url) && /write|request|ensureWorker/i.test(name) },
  { stage: 'solid / render', test: (name, url) => /solid/i.test(url) || /createEffect|runComputation|updateComputation/i.test(name) },
];

function classify(name, url) {
  for (const { stage, test } of STAGES) {
    if (test(name, url)) return stage;
  }
  return 'other';
}

function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const topIdx = argv.indexOf('--top');
  const top = topIdx >= 0 ? Number.parseInt(argv[topIdx + 1], 10) : 20;
  if (!file) {
    console.error('usage: node scripts/analyze-cpuprofile.mjs <file.cpuprofile> [--top N]');
    process.exit(2);
  }

  const profile = JSON.parse(readFileSync(file, 'utf8'));
  const nodeById = new Map();
  for (const node of profile.nodes) nodeById.set(node.id, node);
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];

  const byKey = new Map();
  const byStage = new Map();
  let totalUs = 0;
  let syntheticUs = 0;

  for (let i = 0; i < samples.length; i++) {
    const node = nodeById.get(samples[i]);
    if (!node) continue;
    const us = Math.max(0, deltas[i] ?? 0); // first delta is startTime→first sample
    totalUs += us;
    const name = node.callFrame.functionName || '(anonymous)';
    const url = node.callFrame.url || '(native)';
    if (SYNTHETIC.has(name)) {
      syntheticUs += us;
      const s = byStage.get(name) ?? { us: 0 };
      s.us += us;
      byStage.set(name, s);
      continue;
    }
    const key = `${name}\x00${url}:${node.callFrame.lineNumber}`;
    const entry = byKey.get(key) ?? { name, url, line: node.callFrame.lineNumber, us: 0, hits: 0 };
    entry.us += us;
    entry.hits += 1;
    byKey.set(key, entry);
    const stage = classify(name, url);
    const s = byStage.get(stage) ?? { us: 0 };
    s.us += us;
    byStage.set(stage, s);
  }

  const busyUs = totalUs - syntheticUs;
  const pct = (us) => (totalUs > 0 ? ((us / totalUs) * 100).toFixed(1) : '0.0');
  const shortUrl = (url) => url.replace(/^.*\/(dist|src|node_modules)\//, '$1/').slice(0, 70);

  console.log(`profile: ${file}`);
  console.log(
    `samples: ${samples.length}   wall: ${(totalUs / 1000).toFixed(0)}ms   ` +
      `busy (non-synthetic): ${(busyUs / 1000).toFixed(0)}ms (${pct(busyUs)}%)   ` +
      `synthetic idle/program/gc: ${(syntheticUs / 1000).toFixed(0)}ms (${pct(syntheticUs)}%)`,
  );
  if (samples.length === 0 || busyUs / Math.max(1, totalUs) < 0.05) {
    console.log('\n*** WARNING: trace is essentially idle — the profiler did not observe a busy renderer. ***');
  }

  console.log(`\n── stage breakdown (self-time share of wall) ──`);
  const stages = [...byStage.entries()].sort((a, b) => b[1].us - a[1].us);
  for (const [stage, { us }] of stages) {
    console.log(`  ${pct(us).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)}ms  ${stage}`);
  }

  console.log(`\n── top ${top} functions by self-time ──`);
  const ranked = [...byKey.values()].sort((a, b) => b.us - a.us).slice(0, top);
  ranked.forEach((f, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${pct(f.us).padStart(5)}%  ${(f.us / 1000).toFixed(0).padStart(6)}ms  ` +
        `${String(f.hits).padStart(6)} hits  ${f.name}  ${shortUrl(f.url)}:${f.line}`,
    );
  });
}

main();
