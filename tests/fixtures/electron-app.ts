import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..');

export interface BootedApp {
  app: ElectronApplication;
  window: Page;
  conceptionDir: string;
  userDataDir: string;
  cleanup(): Promise<void>;
}

/**
 * Build a tiny conception fixture (one project, one knowledge note) and launch
 * the production Electron build pointed at it.
 *
 * Pass `prepare` to drop extra files into the conception *before* Electron
 * launches — anything that should be visible on the initial tree read
 * (skills, resources, etc.) belongs there. Files written after `bootApp`
 * returns rely on the chokidar watcher to fire `tree-events`, which is racy
 * under CI's xvfb (the watcher can miss events for files created inside a
 * freshly-mkdir'd directory before its inotify hook attaches).
 */
export async function bootApp(
  options: {
    extraConfig?: Record<string, unknown>;
    prepare?: (conceptionDir: string) => Promise<void>;
    /** Extra env vars merged into the Electron launch — e.g. the
     *  `CONDASH_USER_*` overrides that point the global Skills scope at a
     *  fixture instead of the real `~/.config/agents` etc. */
    env?: Record<string, string>;
  } = {},
): Promise<BootedApp> {
  const conceptionDir = await mkdtemp(join(tmpdir(), 'condash-test-conception-'));
  const userDataDir = await mkdtemp(join(tmpdir(), 'condash-test-userdata-'));

  await mkdir(join(conceptionDir, 'projects', '2026-04', '2026-04-26-sample'), { recursive: true });
  await writeFile(
    join(conceptionDir, 'projects', '2026-04', '2026-04-26-sample', 'README.md'),
    `# Sample project\n\n**Status**: now\n**Kind**: project\n\n## Summary\n\nSample fixture project.\n\n## Steps\n\n- [ ] First step\n- [ ] Second step\n`,
    'utf8',
  );
  await mkdir(join(conceptionDir, 'knowledge'), { recursive: true });
  await writeFile(
    join(conceptionDir, 'knowledge', 'index.md'),
    `# knowledge\n\nFixture knowledge index.\n`,
    'utf8',
  );
  // The per-conception config now lives under `.condash/settings.json`
  // (the auto-migrator lifts a legacy `condash.json` on first run, but
  // writing directly to the canonical path keeps the fixture stable —
  // playwright tests then read/write that same path.)
  await mkdir(join(conceptionDir, '.condash'), { recursive: true });
  await writeFile(
    join(conceptionDir, '.condash', 'settings.json'),
    JSON.stringify({ ...(options.extraConfig ?? {}) }, null, 2) + '\n',
    'utf8',
  );

  // Pre-seed the per-machine settings.json so the app boots straight onto the
  // dashboard view (no folder picker required). The subdir matches
  // package.json's `name` field — that's how Electron picks
  // `app.getPath('userData')`.
  await mkdir(join(userDataDir, 'condash'), { recursive: true });
  await writeFile(
    join(userDataDir, 'condash', 'settings.json'),
    JSON.stringify(
      {
        lastConceptionPath: conceptionDir,
        recentConceptionPaths: [conceptionDir],
        theme: 'system',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // Caller-provided fixture writes — go in before launch so the initial tree
  // read sees them without depending on the chokidar watcher.
  if (options.prepare) {
    await options.prepare(conceptionDir);
  }

  // The suite runs headless by default — but the guarantee lives OUTSIDE this
  // fixture, because Electron can't attach Playwright under a true offscreen
  // (`--ozone-platform=headless`) backend. Instead `npm run test`
  // (scripts/run-playwright.mjs) wraps the whole run in Xvfb with the Wayland
  // socket dropped and the X11 Ozone backend pinned, so Electron renders into a
  // throwaway virtual display and never the live compositor; the globalSetup
  // guard (tests/fixtures/headless-guard.ts) aborts any un-wrapped Wayland run
  // before a window can open. We just inherit that prepared environment here.
  const app = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: repoRoot,
    env: {
      ...process.env,
      // Electron honours XDG_CONFIG_HOME for app.getPath('userData') on Linux.
      XDG_CONFIG_HOME: userDataDir,
      CONDASH_FORCE_PROD: '1',
      ...(options.env ?? {}),
    },
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // The v3.18.0 settings revamp added enter/transition animations. Playwright's
  // actionability check waits for an element to be "stable" (not mid-animation)
  // before clicking; under xvfb those transitions make buttons intermittently
  // never settle, so clicks time out. Tests assert on settled state, not motion
  // — collapse every animation/transition to zero duration app-wide so the DOM
  // is immediately stable. Final rendered pixels are unaffected (only the
  // tweening between states), so screenshot specs stay valid.
  await window
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

  return {
    app,
    window,
    conceptionDir,
    userDataDir,
    cleanup: async () => {
      await app.close().catch(() => undefined);
      await rm(conceptionDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}
