#!/usr/bin/env node
/**
 * Copy the captured screenshots into `docs/assets/screenshots/`.
 *
 * This was a shell recipe in `tests/screenshots.spec.ts`'s header, retyped by
 * hand after every regeneration. It has two traps — the rename (a plain `cp`
 * writes unsuffixed names and lets the dark pass clobber the light one) and the
 * halving back to the logical viewport — and a mis-run is invisible until
 * someone opens the published page: a dark-mode reader served a light
 * screenshot looks like a site bug, not a build step. So it is a script, and it
 * verifies its own output.
 *
 *   node scripts/publish-screenshots.mjs [--check]
 *
 * `--check` verifies what is already in `docs/` without rewriting it.
 *
 * Requires ImageMagick (`convert`) and `pngquant`, both docs-authoring tools
 * only — nothing in CI runs this, so the tag-time release stays clean.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
const outRoot = join(repoRoot, 'tests', 'screenshots-out');
const docsRoot = join(repoRoot, 'docs', 'assets', 'screenshots');
const THEMES = ['light', 'dark'];
/** Mirrors `tests/viewport.ts`; the docs ship the logical size, so nothing
 *  published may exceed it. Duplicated rather than imported because this script
 *  is plain Node with no TS pipeline. */
const VIEWPORT = { width: 1600, height: 1250 };
const checkOnly = process.argv.includes('--check');

const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

async function slugsFor(theme) {
  const dir = join(outRoot, theme);
  const found = await readdir(dir).catch(() => null);
  if (!found) throw new Error(`no captures at ${dir} — run the screenshots spec first`);
  return found.filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4));
}

/** Slugs already published, read from `docs/`. `--check` uses these so it can
 *  verify a plain checkout: the spec wipes `tests/screenshots-out/` at the start
 *  of every run, which is exactly when a reviewer wants to re-verify. */
async function publishedSlugs() {
  const found = await readdir(docsRoot).catch(() => []);
  const slugs = new Set();
  for (const f of found) {
    if (!f.endsWith('.png')) continue;
    const m = /^(.*)-(light|dark)\.png$/.exec(f);
    if (m) slugs.add(m[1]);
  }
  return [...slugs].sort();
}

/** Pixel dimensions straight from the IHDR chunk — no image library needed. */
async function pngSize(file) {
  const head = await readFile(file);
  if (head.length < 24) return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

async function main() {
  let slugs;
  if (checkOnly) {
    // Union, not either/or. Reading `docs/` is what lets `--check` work on a
    // plain checkout (the spec wipes the capture dir at the start of each run),
    // but reading only `docs/` cannot see a slug that was captured and never
    // published — add a shot, run the spec, forget to publish, and the check
    // would report every published pair fine while the page ships a broken
    // image. When captures are present they widen the list; they never narrow it.
    const captured = await Promise.all(
      THEMES.map((t) => slugsFor(t).catch(() => [])),
    );
    slugs = [...new Set([...(await publishedSlugs()), ...captured.flat()])].sort();
    if (!slugs.length) throw new Error(`nothing published under ${docsRoot} and no captures to check`);
  } else {
    const [light, dark] = await Promise.all(THEMES.map(slugsFor));
    const onlyLight = light.filter((s) => !dark.includes(s));
    const onlyDark = dark.filter((s) => !light.includes(s));
    if (onlyLight.length || onlyDark.length) {
      throw new Error(
        `themes disagree — light only: [${onlyLight}], dark only: [${onlyDark}]. ` +
          `Both passes must produce the same slugs.`,
      );
    }
    slugs = light;
  }

  if (!checkOnly) {
    for (const theme of THEMES) {
      for (const slug of slugs) {
        const src = join(outRoot, theme, `${slug}.png`);
        const dest = join(docsRoot, `${slug}-${theme}.png`);
        // Halve the 2x capture: the docs ship the logical size, and a straight
        // 1x capture loses the display serif's hinting.
        await run('convert', [src, '-resize', '50%', '-strip', dest]);
        // pngquant exits 98 when it cannot reach the quality floor and 99 when
        // the quantized file would be larger. Both mean "keep the file as it
        // is", not "abort" — and aborting here left docs/ half-written with the
        // verification below never reached. The old shell recipe ran pngquant
        // over a glob, where the status was simply discarded.
        await run('pngquant', [
          '--force',
          '--skip-if-larger',
          '--quality=70-95',
          '--ext',
          '.png',
          dest,
        ]).catch((err) => {
          if (err?.code === 98 || err?.code === 99) return;
          throw err;
        });
      }
    }
  }

  // Verify what landed. The identity check is the one that matters: it is the
  // signature of the rename trap, and nothing else in the pipeline can see it —
  // the spec's own file-level checks read `tests/screenshots-out/`, not `docs/`.
  const problems = [];
  for (const slug of slugs) {
    const paths = THEMES.map((t) => join(docsRoot, `${slug}-${t}.png`));
    // Count before, compare after: a global `problems.some(p => p.includes(slug))`
    // also matches another slug's entry — `code-pane` is a substring of
    // `code-pane-dirty` — and would skip the identity check below for a slug
    // that is perfectly readable.
    const before = problems.length;
    for (const p of paths) {
      const info = await stat(p).catch(() => null);
      if (!info) problems.push(`missing: ${p}`);
      else if (info.size < 2048) problems.push(`implausibly small (${info.size} B): ${p}`);
    }
    if (problems.length !== before) continue;

    const [lightHash, darkHash] = await Promise.all(paths.map(digest));
    if (lightHash === darkHash) {
      problems.push(
        `${slug}: the light and dark files are byte-identical — one pass clobbered the other`,
      );
    }
    for (const p of paths) {
      const size = await pngSize(p);
      // Clips are smaller than the window by definition; only full-window shots
      // carry the logical viewport, and a dropped `-resize 50%` would otherwise
      // ship 2× images that nothing downstream measures.
      if (!size) problems.push(`unreadable PNG header: ${p}`);
      else if (size.width > VIEWPORT.width || size.height > VIEWPORT.height) {
        problems.push(
          `${p} is ${size.width}×${size.height}, larger than the logical ` +
            `${VIEWPORT.width}×${VIEWPORT.height} — was the halving skipped?`,
        );
      }
    }
  }
  if (problems.length) {
    console.error(`publish-screenshots: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `publish-screenshots: ${slugs.length} slugs × ${THEMES.length} themes ` +
      `${checkOnly ? 'verified in' : 'published to'} docs/assets/screenshots/`,
  );
}

await main();
