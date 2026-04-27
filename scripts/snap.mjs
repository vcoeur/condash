#!/usr/bin/env node
// Launch condash-electron pointed at the live conception, take a screenshot
// of each tab, and exit. Used to verify UI changes visually without manual
// click-through.
//
// Usage:
//   node scripts/snap.mjs                            # all tabs
//   node scripts/snap.mjs projects code              # selected tabs
//
// Output: /tmp/condash-snap/<tab>.png
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const REAL_CONCEPTION = process.env.CONDASH_CONCEPTION_PATH ?? '/home/alice/src/vcoeur/conception';
const OUT_DIR = '/tmp/condash-snap';
const TABS = ['projects', 'code', 'knowledge', 'history', 'search'];

async function main() {
  const requested = process.argv.slice(2);
  const tabs = requested.length ? requested : TABS;
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const userData = await mkdtemp(join(tmpdir(), 'condash-snap-userdata-'));
  await mkdir(join(userData, 'condash-electron'), { recursive: true });
  await writeFile(
    join(userData, 'condash-electron', 'settings.json'),
    JSON.stringify({ conceptionPath: REAL_CONCEPTION, theme: 'light' }) + '\n',
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
  await win.setViewportSize({ width: 1400, height: 900 });
  await win.locator('.row .title').first().waitFor({ timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 2000)); // settle

  for (const tab of tabs) {
    if (tab === 'terminal') {
      await win.locator('button[title^="Toggle terminal"]').first().click().catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      // Spawn a couple of tabs so the strip has something to render.
      await win.locator('button.terminal-tab-add').first().click().catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      await win.locator('button.terminal-tab-add').first().click().catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      const out = `${OUT_DIR}/terminal.png`;
      await win.screenshot({ path: out, fullPage: false });
      console.log(`[snap] terminal → ${out}`);
      continue;
    }
    const label = tab[0].toUpperCase() + tab.slice(1);
    await win.locator(`button.tab:has-text("${label}")`).first().click().catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    const out = `${OUT_DIR}/${tab}.png`;
    await win.screenshot({ path: out, fullPage: false });
    console.log(`[snap] ${tab} → ${out}`);
  }

  await app.close();
  await rm(userData, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
