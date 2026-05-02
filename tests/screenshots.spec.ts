/**
 * Screenshot harness.
 *
 * Drives the packaged Electron build against the bundled `tests/fixtures/conception-demo`
 * and captures the 31 PNGs that the public docs site references.
 *
 * Run as `npm run test -- --reporter=list screenshots.spec.ts`. Output lands in
 * `tests/screenshots-out/{light,dark}/<name>.png`. The matching pair is then
 * copied into `docs/assets/screenshots/<name>-{light,dark}.png` by hand or by
 * the helper script in `scripts/sync-screenshots.mjs`.
 *
 * Window is forced to 1600×1100 logical px with deviceScaleFactor=2 so the
 * captured PNGs come out at 3200×2200 — matching the Tauri-era originals.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
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
  await writeFile(
    join(userDataDir, 'condash', 'settings.json'),
    JSON.stringify({ conceptionPath: conceptionDir, theme }, null, 2) + '\n',
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
    // 1. dashboard-overview / projects-current — landing view with the Projects pane visible.
    await showPane(b, 'Projects');
    await shoot(page, theme, 'dashboard-overview');
    await shoot(page, theme, 'projects-current');

    // 2. projects-next / projects-backlog / projects-done — the Electron build stacks
    //    every status group on a single scroll, so we approximate the Tauri filter
    //    tabs by scrolling each section's heading into view before shooting.
    for (const slug of ['projects-next', 'projects-backlog', 'projects-done']) {
      const heading = slug.replace('projects-', '');
      const h = page.locator(`.projects-section[data-status="${heading}"]`).first();
      if (await h.count()) {
        await h.scrollIntoViewIfNeeded();
        await settle(page);
      }
      await shoot(page, theme, slug);
    }
    // Reset scroll for the next shots.
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page);

    // 3. code-tab.
    await showPane(b, 'Code');
    await shoot(page, theme, 'code-tab');

    // 4. knowledge-tab.
    await showPane(b, 'Knowledge');
    await shoot(page, theme, 'knowledge-tab');

    // 5. history-tab — Electron has no History tab. Capture the Projects view as
    //    the closest analog so the PNG slot stays populated; the docs page that
    //    references it will be rewritten in the same PR.
    await showPane(b, 'Projects');
    await shoot(page, theme, 'history-tab');

    // 6. gear-modal* — open Settings via the File → Settings menu command.
    //    The Electron build has tabs General / Terminal / configuration.json /
    //    Shortcuts; we map the Tauri-era "preferences" → Terminal (the
    //    live-edit per-user prefs) and "repositories" → configuration.json
    //    (the editor that owns the repositories[] block of the JSON).
    await sendMenu(b.app, 'open-settings');
    await settle(page);
    await shoot(page, theme, 'gear-modal');
    const termTab = page.locator('.settings-tabs .settings-tab', { hasText: /^Terminal$/ }).first();
    if (await termTab.count()) {
      await termTab.click();
      await settle(page);
    }
    await shoot(page, theme, 'gear-modal-preferences');
    const configTab = page.locator('.settings-tabs .settings-tab', { hasText: /configuration\.json/i }).first();
    if (await configTab.count()) {
      await configTab.click();
      await settle(page);
      await page.waitForTimeout(400);
    }
    await shoot(page, theme, 'gear-modal-repositories');
    // Close the modal (Esc).
    await page.keyboard.press('Escape');
    await settle(page);

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
    const searchInput = page.locator('.search-modal input, .search-input, input[placeholder*="search" i]').first();
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

    // 11. wikilink-source — only one shot, captured in light mode only. Open
    //     a knowledge note that contains a [[wikilink]] so the resolved link
    //     renders in the note modal.
    if (theme === 'light') {
      await showPane(b, 'Knowledge');
      // Card list is flat — click the helio card directly. The Knowledge
      // tab used to be a tree (`.knowledge-dir` / `.knowledge-leaf`) and
      // needed an expand step; cards make that obsolete.
      const helio = page.locator('.knowledge-card', { hasText: /helio/i }).first();
      if (await helio.count()) {
        await helio.click();
        await settle(page);
        await page.waitForTimeout(400);
      }
      await shoot(page, theme, 'wikilink-source');
    }
  } finally {
    await shutdown(b);
  }
}

test('capture all 31 screenshots in light + dark', async () => {
  test.setTimeout(180_000);
  await rm(outRoot, { recursive: true, force: true });
  await captureForTheme('light');
  await captureForTheme('dark');
  expect(true).toBe(true);
});
