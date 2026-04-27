#!/usr/bin/env node
// Capture a real perf baseline against the user's conception tree.
//
// Drives a packaged-style production run via Playwright's _electron API,
// points the app at the live ~/src/vcoeur/conception/ tree (read-only
// interactions only — no mutations), and samples pidstat over the Electron
// process group across four interaction windows. Repeats RUNS times.
//
// Output:
//   /tmp/perf-baseline/run<N>-<window>.txt   raw pidstat capture
//   /tmp/perf-baseline/summary.json          parsed averages
//
// Usage:
//   node scripts/perf-baseline.mjs              # 3 runs, 30 s windows
//   PERF_RUNS=1 PERF_WINDOW_SECS=10 node ...    # quick smoke

import { _electron as electron } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const REAL_CONCEPTION = process.env.CONDASH_CONCEPTION_PATH ?? '/home/alice/src/vcoeur/conception';
const RUNS = Number.parseInt(process.env.PERF_RUNS ?? '3', 10);
const WINDOW_SECS = Number.parseInt(process.env.PERF_WINDOW_SECS ?? '30', 10);
const OUT_DIR = '/tmp/perf-baseline';

const WINDOWS = ['idle', 'mousemove', 'tabswitch', 'projectscroll'];

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const projectsCount = countDirs(`${REAL_CONCEPTION}/projects`, 2);
  const knowledgeCount = countFiles(`${REAL_CONCEPTION}/knowledge`, '*.md');
  console.log(`[perf] conception: ${REAL_CONCEPTION}`);
  console.log(`[perf] projects=${projectsCount}, knowledge.md=${knowledgeCount}`);
  console.log(`[perf] runs=${RUNS}, window=${WINDOW_SECS}s × ${WINDOWS.length} windows`);

  const allRuns = [];
  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n[perf] === run ${run}/${RUNS} ===`);
    allRuns.push(await captureRun(run));
  }

  const summary = summarise(allRuns);
  await writeFile(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(`\n[perf] summary written to ${OUT_DIR}/summary.json`);
  console.table(summary.windows);
}

async function captureRun(run) {
  const userData = await mkdtemp(join(tmpdir(), 'condash-perf-userdata-'));
  await mkdir(join(userData, 'condash-electron'), { recursive: true });
  await writeFile(
    join(userData, 'condash-electron', 'settings.json'),
    JSON.stringify({ conceptionPath: REAL_CONCEPTION, theme: 'system' }) + '\n',
  );

  const app = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: repoRoot,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: userData,
      CONDASH_FORCE_PROD: '1',
      CONDASH_CONCEPTION_PATH: REAL_CONCEPTION,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.locator('.row .title').first().waitFor({ timeout: 15_000 });
  await sleep(3_000); // settle

  const electronPid = app.process().pid;
  const windowResults = {};

  try {
    windowResults.idle = await captureWindow(run, 'idle', electronPid, async () => {
      await sleep(WINDOW_SECS * 1000);
    });

    windowResults.mousemove = await captureWindow(run, 'mousemove', electronPid, async () => {
      const end = Date.now() + WINDOW_SECS * 1000;
      while (Date.now() < end) {
        await win.mouse.move(50 + Math.random() * 1100, 150 + Math.random() * 600);
        await sleep(25);
      }
    });

    windowResults.tabswitch = await captureWindow(run, 'tabswitch', electronPid, async () => {
      const tabs = ['Knowledge', 'History', 'Projects'];
      const end = Date.now() + WINDOW_SECS * 1000;
      let i = 0;
      while (Date.now() < end) {
        const label = tabs[i % tabs.length];
        await win
          .locator(`button.tab:has-text("${label}")`)
          .first()
          .click({ timeout: 1500 })
          .catch(() => {});
        i++;
        await sleep(500);
      }
      // Leave on Projects for the next window.
      await win.locator('button.tab:has-text("Projects")').first().click().catch(() => {});
    });

    windowResults.projectscroll = await captureWindow(run, 'projectscroll', electronPid, async () => {
      // Scroll the projects list up and down — exercises card render under load.
      const grid = win.locator('main, .grid, .projects, body').first();
      const end = Date.now() + WINDOW_SECS * 1000;
      let direction = 1;
      while (Date.now() < end) {
        await grid.evaluate((el, dy) => {
          const target = document.scrollingElement ?? document.documentElement;
          target.scrollBy(0, dy);
        }, 400 * direction);
        await sleep(120);
        if ((Date.now() / 1000) % 8 < 0.2) direction = -direction;
        else if (Math.random() < 0.05) direction = -direction;
      }
    });
  } finally {
    await app.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }

  return { run, electronPid, windows: windowResults };
}

async function captureWindow(run, label, electronPid, body) {
  const pids = electronProcessPids(electronPid);
  const outFile = `${OUT_DIR}/run${run}-${label}.txt`;
  console.log(`[perf]   window=${label} pids=${pids.length} → ${outFile}`);

  const pidstat = spawn('pidstat', ['-h', '-r', '-u', '-p', pids.join(','), '1', String(WINDOW_SECS)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_TIME: 'C', LC_ALL: 'C' },
  });
  const chunks = [];
  pidstat.stdout.on('data', (c) => chunks.push(c));
  pidstat.stderr.on('data', (c) => process.stderr.write(c));
  const exited = new Promise((res) => pidstat.once('exit', res));

  await body();
  await exited;
  const raw = Buffer.concat(chunks).toString();
  await writeFile(outFile, raw);
  return parsePidstat(raw);
}

function electronProcessPids(rootPid) {
  // Walk the process tree rooted at the Electron main process and collect
  // every descendant — main, renderer, gpu, utility, node-pty children.
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    let children;
    try {
      children = execSync(`pgrep -P ${parent}`, { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(Number);
    } catch {
      continue; // pgrep exits non-zero if no children
    }
    for (const c of children) {
      if (!seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
    }
  }
  return [...seen];
}

function parsePidstat(text) {
  // pidstat -h -u -r emits one row per pid per second. Columns from the right
  // are stable (Command, %MEM, RSS, VSZ, majflt/s, minflt/s, CPU, %CPU, %wait,
  // %guest, %system, %usr, PID, UID), so we index from the end. This is robust
  // against locale-specific time formats (12h adds an AM/PM token).
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('Linux'));
  // Per-second sum across all sampled pids → one data point per second.
  const perSecond = new Map();
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 14) continue;
    const cpu = Number.parseFloat(cols[cols.length - 8]); // %CPU
    const rss = Number.parseInt(cols[cols.length - 3], 10); // RSS in kB
    const time = cols.slice(0, cols.length - 14).join(' '); // 1 or 2 leading time tokens
    if (!Number.isFinite(cpu) || !Number.isFinite(rss)) continue;
    const acc = perSecond.get(time) ?? { cpu: 0, rss: 0 };
    acc.cpu += cpu;
    acc.rss += rss;
    perSecond.set(time, acc);
  }
  const points = [...perSecond.values()];
  if (points.length === 0) {
    return { samples: 0, avgCpu: 0, peakCpu: 0, avgRssKb: 0 };
  }
  const peak = points.reduce((m, p) => Math.max(m, p.cpu), 0);
  const avg = points.reduce((s, p) => s + p.cpu, 0) / points.length;
  const rssAvg = points.reduce((s, p) => s + p.rss, 0) / points.length;
  return {
    samples: points.length,
    avgCpu: +avg.toFixed(2),
    peakCpu: +peak.toFixed(2),
    avgRssKb: Math.round(rssAvg),
  };
}

function summarise(allRuns) {
  const out = { runs: allRuns.length, windows: {} };
  for (const w of WINDOWS) {
    const samples = allRuns.map((r) => r.windows[w]).filter(Boolean);
    if (samples.length === 0) continue;
    const mean = (key) => +(samples.reduce((a, s) => a + s[key], 0) / samples.length).toFixed(2);
    const max = (key) => Math.max(...samples.map((s) => s[key]));
    out.windows[w] = {
      runs: samples.length,
      avgCpuMean: mean('avgCpu'),
      peakCpuMax: max('peakCpu'),
      avgRssKbMean: Math.round(mean('avgRssKb')),
    };
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function countDirs(path, depth) {
  try {
    return Number.parseInt(
      execSync(`find ${path} -mindepth ${depth} -maxdepth ${depth} -type d | wc -l`, { encoding: 'utf8' }).trim(),
      10,
    );
  } catch {
    return -1;
  }
}

function countFiles(path, glob) {
  try {
    return Number.parseInt(
      execSync(`find ${path} -name '${glob}' | wc -l`, { encoding: 'utf8' }).trim(),
      10,
    );
  } catch {
    return -1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
