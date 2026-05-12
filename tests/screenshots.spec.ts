/**
 * Screenshot harness.
 *
 * Drives the packaged Electron build against the bundled `tests/fixtures/conception-demo`
 * and captures the 10 PNG slugs (× 2 themes = 20 files) that the public docs site references.
 *
 * Run as `npm run test -- --reporter=list screenshots.spec.ts`. Output lands in
 * `tests/screenshots-out/{light,dark}/<name>.png`. The matching pair is then
 * copied by hand into `docs/assets/screenshots/<name>-{light,dark}.png`
 * (e.g. `cp tests/screenshots-out/{light,dark}/*.png docs/assets/screenshots/`).
 *
 * Window is forced to 1600×1100 logical px with deviceScaleFactor=2 so the
 * captured PNGs come out at 3200×2200 — matching the Tauri-era originals.
 */

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');
const fixtureSrc = resolve(__dirname, 'fixtures', 'conception-demo');
const outRoot = resolve(__dirname, 'screenshots-out');

type Theme = 'light' | 'dark';

interface Booted {
  app: ElectronApplication;
  page: Page;
  conceptionDir: string;
  userDataDir: string;
}

async function boot(theme: Theme): Promise<Booted> {
  const conceptionDir = await mkdtemp(join(tmpdir(), 'condash-shots-conception-'));
  const userDataDir = await mkdtemp(join(tmpdir(), 'condash-shots-userdata-'));

  await cp(fixtureSrc, conceptionDir, { recursive: true });

  await mkdir(join(userDataDir, 'condash'), { recursive: true });
  // Layout: projects + code visible at 50/50 (798px each + 4px splitter on
  // the 1600px viewport) so the documentation screenshots show both panes
  // with comparable weight. Terminal off by default — individual shots
  // toggle it on as needed.
  await writeFile(
    join(userDataDir, 'condash', 'settings.json'),
    JSON.stringify(
      {
        lastConceptionPath: conceptionDir,
        recentConceptionPaths: [conceptionDir],
        theme,
        layout: {
          projects: true,
          working: 'code',
          terminal: false,
          projectsWidth: 798,
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--force-device-scale-factor=2'],
    cwd: repoRoot,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: userDataDir,
      CONDASH_FORCE_PROD: '1',
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Pin viewport so the captured PNG is exactly 3200×2200 at scale-factor 2.
  await page.setViewportSize({ width: 1600, height: 1100 });
  // Wait for the left edge strip so we know the renderer mounted. The strip
  // is always rendered (it hosts the Projects handle), so it's a stable
  // mount landmark independent of whether a conception path is loaded.
  await page.locator('.edge-strip-left').first().waitFor({ state: 'visible', timeout: 10_000 });
  // Ensure the persisted theme has actually been applied to <html data-theme>.
  await page.evaluate((t) => {
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
    else root.removeAttribute('data-theme');
  }, theme);
  return { app, page, conceptionDir, userDataDir };
}

async function shutdown(b: Booted): Promise<void> {
  await b.app.close().catch(() => undefined);
  await rm(b.conceptionDir, { recursive: true, force: true });
  await rm(b.userDataDir, { recursive: true, force: true });
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(250);
}

async function shoot(page: Page, theme: Theme, name: string): Promise<void> {
  const dir = join(outRoot, theme);
  await mkdir(dir, { recursive: true });
  try {
    await page.screenshot({
      path: join(dir, `${name}.png`),
      fullPage: false,
      timeout: 8_000,
    });
  } catch (err) {
    // CodeMirror / heavy DOM occasionally stalls Playwright's screenshot pipe.
    // Don't let one bad shot abort the whole sweep — log and move on.
    console.error(`[shoot] ${theme}/${name} failed: ${(err as Error).message}`);
  }
}

/** Send a menu-command IPC to the renderer. The composite layout has no
 *  in-window tab strip — pane visibility is driven by the application menu
 *  ('toggle-projects', 'show-code', 'show-knowledge', 'hide-working',
 *  'open-settings', 'toggle-terminal', 'search'), so screenshot prep goes
 *  through the same channel a real menu click would. */
async function sendMenu(app: ElectronApplication, command: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, cmd) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.send('menu-command', cmd);
  }, command);
}

/** Show one pane in the working-surface slot. Mirrors the menu's
 *  Show Projects / Show Code / Show Knowledge items — the renderer makes
 *  Code and Knowledge mutually exclusive in that slot. */
async function showPane(b: Booted, label: 'Projects' | 'Code' | 'Knowledge'): Promise<void> {
  if (label === 'Projects') {
    // toggle-projects is idempotent only against the live state; check the
    // edge handle's aria-pressed and toggle only when Projects is hidden.
    const handle = b.page.locator('.edge-strip-left .edge-handle').first();
    const pressed = (await handle.getAttribute('aria-pressed')) === 'true';
    if (!pressed) await sendMenu(b.app, 'toggle-projects');
  } else if (label === 'Code') {
    await sendMenu(b.app, 'show-code');
  } else {
    await sendMenu(b.app, 'show-knowledge');
  }
  await settle(b.page);
}

async function captureForTheme(theme: Theme): Promise<void> {
  const b = await boot(theme);
  const { page } = b;
  try {
    // 1. dashboard-overview — landing view with the Projects pane visible.
    await showPane(b, 'Projects');
    await shoot(page, theme, 'dashboard-overview');

    // 2. projects-done — capture only the Done status group (the other
    //    sub-pane shots — current / next / backlog — used to be in this loop
    //    but were never referenced from docs and were pruned together with
    //    their PNG files. Re-introduce them here if a docs page starts
    //    citing them again).
    {
      const slug = 'projects-done';
      const section = page
        .locator('.group-block[data-status="done"], .projects-section[data-status="done"]')
        .first();
      if (await section.count()) {
        await section.scrollIntoViewIfNeeded();
        await settle(page);
        const box = await section.boundingBox();
        if (box) {
          try {
            await page.screenshot({
              path: join(outRoot, theme, `${slug}.png`),
              clip: {
                x: Math.max(0, box.x - 16),
                y: Math.max(0, box.y - 16),
                width: Math.min(box.width + 32, 1600),
                height: Math.min(box.height + 32, 1100),
              },
              timeout: 8_000,
            });
          } catch (err) {
            console.error(`[shoot-clip] ${theme}/${slug}: ${(err as Error).message}`);
          }
        }
      } else {
        console.warn(`[shoot] ${theme}/${slug}: "done" section not present in fixture, skipped`);
      }
    }
    // Reset scroll for the next shots.
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page);

    // 3. code-pane.
    await showPane(b, 'Code');
    await shoot(page, theme, 'code-pane');

    // 4. knowledge-pane.
    await showPane(b, 'Knowledge');
    await shoot(page, theme, 'knowledge-pane');

    // 7. terminal — toggle the terminal pane via the View → Show Terminal menu.
    await sendMenu(b.app, 'toggle-terminal');
    await settle(page);
    await shoot(page, theme, 'terminal');
    // Close it again.
    await sendMenu(b.app, 'toggle-terminal');
    await settle(page);

    // 8. item-fuzzy-search — open the search modal via the File menu's
    //    `menu-command` IPC ('search').
    await sendMenu(b.app, 'search');
    await settle(page);
    const searchInput = page
      .locator('.search-modal input, .search-input, input[placeholder*="search" i]')
      .first();
    if (await searchInput.count()) {
      await searchInput.fill('fuzzy');
      await settle(page);
      await page.waitForTimeout(400);
    }
    await shoot(page, theme, 'item-fuzzy-search');
    await page.keyboard.press('Escape');
    await settle(page);

    // 9. item-document-with-pdf — open a document item that has a PDF deliverable.
    //    The demo fixture's `2026-04-10-plugin-api-proposal/deliverables/` ships
    //    a PDF; click that card to open the note modal.
    await showPane(b, 'Projects');
    const docCard = page.locator('.row', { hasText: /plugin API proposal/i }).first();
    if (await docCard.count()) {
      await docCard.click();
      await settle(page);
    }
    await shoot(page, theme, 'item-document-with-pdf');
    await page.keyboard.press('Escape');
    await settle(page);

    // 10. status-unknown-badge — the demo fixture's `2026-04-18-typo-status-demo`
    //     intentionally carries a non-canonical status so the warn badge renders.
    //     Scroll its row into view if present.
    const unknownRow = page.locator('.row', { hasText: /typo|status-demo/i }).first();
    if (await unknownRow.count()) {
      await unknownRow.scrollIntoViewIfNeeded();
      await settle(page);
    }
    await shoot(page, theme, 'status-unknown-badge');

    // 12. resources-pane — Show via the View → Show Resources menu command
    //     (Ctrl+R since v2.10.21). The fixture's resources/ has 2 root files
    //     and one subdir (notes/) so the pane renders with both a ROOT
    //     section and a NOTES section.
    await sendMenu(b.app, 'show-resources');
    await settle(page);
    await page.waitForTimeout(400);
    await shoot(page, theme, 'resources-pane');

    // 13. skills-pane — Show via the View → Show Skills menu command (Ctrl+L).
    //     The fixture's .claude/skills/example-skill/ has a SKILL.md plus a
    //     companion file so the pane renders with the [SKILL] index badge.
    await sendMenu(b.app, 'show-skills');
    await settle(page);
    await page.waitForTimeout(400);
    await shoot(page, theme, 'skills-pane');
  } finally {
    await shutdown(b);
  }
}

test('capture all 20 screenshots in light + dark', async () => {
  test.setTimeout(240_000);
  await rm(outRoot, { recursive: true, force: true });
  await captureForTheme('light');
  await captureForTheme('dark');
  expect(true).toBe(true);
});
