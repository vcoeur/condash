/**
 * Theme-system live screenshots.
 *
 * Same launch pattern as screenshots.spec.ts, but pointed at the REAL
 * conception tree (/home/alice/src/vcoeur/conception) so each theme is judged
 * against real data rather than a fixture. Boots once per theme preset and
 * captures the dashboard in it, then captures the Settings → Appearance theme
 * picker. Strictly read-only towards the conception: render + screenshot only,
 * no mutating clicks (no sync-now, no new-project, no stop/run, and the
 * settings modal is opened but never saved).
 *
 * Run as `npm run test -- --reporter=list ui-revamp-shots.spec.ts`. Output
 * lands in `tests/screenshots-out/ui-revamp/<name>.png` at 3200×2200
 * (1600×1100 logical, deviceScaleFactor=2), mirroring screenshots.spec.ts.
 */

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');
const outRoot = resolve(__dirname, 'screenshots-out', 'ui-revamp');

/** The real tree — never copied, never deleted, never mutated by this spec. */
const REAL_CONCEPTION = '/home/alice/src/vcoeur/conception';

/** Registry ids from src/shared/themes.ts. */
const THEMES = ['light', 'dark', 'console'] as const;

interface Booted {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
}

async function boot(theme: string): Promise<Booted> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'condash-ui-revamp-userdata-'));

  await mkdir(join(userDataDir, 'condash'), { recursive: true });
  // Same 50/50 projects+code layout seed as screenshots.spec.ts so the shots
  // are comparable to the docs captures. Terminal off by default.
  await writeFile(
    join(userDataDir, 'condash', 'settings.json'),
    JSON.stringify(
      {
        lastConceptionPath: REAL_CONCEPTION,
        recentConceptionPaths: [REAL_CONCEPTION],
        theme,
        layout: {
          projects: true,
          working: 'code',
          terminal: false,
          projectsSplit: 0.5,
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
  // Collapse animations/transitions (same trick as tests/fixtures/electron-app.ts):
  // under xvfb the settings-revamp transitions can keep elements "unstable"
  // for Playwright's actionability checks. Final rendered pixels are unaffected.
  await page
    .addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }`,
    })
    .catch(() => undefined);
  // Wait for the activity rail so we know the renderer mounted.
  await page.locator('.rail').first().waitFor({ state: 'visible', timeout: 15_000 });
  // The persisted theme is applied by use-theme once the bootstrap IPC lands,
  // so wait for the attribute rather than forcing it — that way the shot also
  // proves the real hydration path set it.
  await page.waitForFunction(
    (expected) => document.documentElement.dataset.theme === expected,
    theme,
    { timeout: 10_000 },
  );
  return { app, page, userDataDir };
}

async function shutdown(b: Booted): Promise<void> {
  await b.app.close().catch(() => undefined);
  // Only the temp XDG dir is removed — the real conception is untouched.
  await rm(b.userDataDir, { recursive: true, force: true });
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.waitForTimeout(ms);
}

async function shoot(page: Page, name: string): Promise<void> {
  await mkdir(outRoot, { recursive: true });
  try {
    await page.screenshot({
      path: join(outRoot, `${name}.png`),
      fullPage: false,
      timeout: 8_000,
    });
  } catch (err) {
    console.error(`[shoot] ui-revamp/${name} failed: ${(err as Error).message}`);
  }
}

/** Send a menu-command IPC to the renderer, same as screenshots.spec.ts. */
async function sendMenu(app: ElectronApplication, command: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, cmd) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.send('menu-command', cmd);
  }, command);
}

for (const theme of THEMES) {
  test(`capture the ${theme} theme against the real conception`, async () => {
    test.setTimeout(180_000);
    const b = await boot(theme);
    const { page } = b;
    try {
      await page.locator('.rail').first().waitFor({ state: 'visible' });
      // The real tree is larger than the demo fixture, so give the first tree
      // read a little longer before capturing.
      await settle(page, 1500);
      await shoot(page, `theme-${theme}-dashboard`);

      // Both dark presets must resolve to kind=dark, and light to kind=light —
      // this is what every hljs / app-pill / dashboard dark rule now keys on.
      const kind = await page.evaluate(() => document.documentElement.dataset.themeKind);
      expect(kind).toBe(theme === 'light' ? 'light' : 'dark');
    } finally {
      await shutdown(b);
    }
  });
}

test('capture the Settings theme picker and its hover preview', async () => {
  test.setTimeout(180_000);
  // Boot on warm-gallery so the hover preview has something to change *to*.
  const b = await boot('dark');
  const { page } = b;
  try {
    await settle(page, 1500);
    await sendMenu(b.app, 'open-settings');
    await settle(page, 600);

    const picker = page.locator('.theme-picker');
    await picker.waitFor({ state: 'visible', timeout: 10_000 });
    await picker.scrollIntoViewIfNeeded();
    await settle(page, 300);
    await shoot(page, 'theme-picker');
    // The swatch is absolutely-positioned inside, so a layout regression would
    // collapse it to zero width and still screenshot as a plausible-looking
    // card. Assert it actually has area.
    const swatchWidth = await page
      .locator('.theme-card-swatch')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(swatchWidth).toBeGreaterThan(40);

    // Hover the Console card: the whole modal (and the app behind it) should
    // repaint in Console without anything being saved.
    const consoleCard = page.locator('.theme-card[data-theme-id="console"]');
    await consoleCard.hover();
    await settle(page, 300);
    const previewed = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(previewed).toBe('console');
    await shoot(page, 'theme-picker-preview-console');

    // Moving away reverts to the saved theme — the preview leaves no state.
    await page.locator('.settings-field-label').first().hover();
    await settle(page, 300);
    const reverted = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(reverted).toBe('dark');
  } finally {
    await shutdown(b);
  }
});
