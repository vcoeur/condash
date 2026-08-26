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
const checkOnly = process.argv.includes('--check');

const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

async function slugsFor(theme) {
  const dir = join(outRoot, theme);
  const found = await readdir(dir).catch(() => null);
  if (!found) throw new Error(`no captures at ${dir} — run the screenshots spec first`);
  return found.filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4));
}

async function main() {
  const [light, dark] = await Promise.all(THEMES.map(slugsFor));
  const onlyLight = light.filter((s) => !dark.includes(s));
  const onlyDark = dark.filter((s) => !light.includes(s));
  if (onlyLight.length || onlyDark.length) {
    throw new Error(
      `themes disagree — light only: [${onlyLight}], dark only: [${onlyDark}]. ` +
        `Both passes must produce the same slugs.`,
    );
  }

  if (!checkOnly) {
    for (const theme of THEMES) {
      for (const slug of light) {
        const src = join(outRoot, theme, `${slug}.png`);
        const dest = join(docsRoot, `${slug}-${theme}.png`);
        // Halve the 2x capture: the docs ship the logical size, and a straight
        // 1x capture loses the display serif's hinting.
        await run('convert', [src, '-resize', '50%', '-strip', dest]);
        await run('pngquant', [
          '--force',
          '--skip-if-larger',
          '--quality=70-95',
          '--ext',
          '.png',
          dest,
        ]);
      }
    }
  }

  // Verify what landed. The identity check is the one that matters: it is the
  // signature of the rename trap, and nothing else in the pipeline can see it —
  // the spec's own file-level checks read `tests/screenshots-out/`, not `docs/`.
  const problems = [];
  for (const slug of light) {
    const paths = THEMES.map((t) => join(docsRoot, `${slug}-${t}.png`));
    for (const p of paths) {
      const info = await stat(p).catch(() => null);
      if (!info) problems.push(`missing: ${p}`);
      else if (info.size < 1024) problems.push(`implausibly small (${info.size} B): ${p}`);
    }
    if (problems.some((p) => p.includes(slug))) continue;
    const [lightHash, darkHash] = await Promise.all(paths.map(digest));
    if (lightHash === darkHash) {
      problems.push(
        `${slug}: the light and dark files are byte-identical — one pass clobbered the other`,
      );
    }
  }
  if (problems.length) {
    console.error(`publish-screenshots: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `publish-screenshots: ${light.length} slugs × ${THEMES.length} themes ` +
      `${checkOnly ? 'verified' : 'published'} to docs/assets/screenshots/`,
  );
}

await main();
