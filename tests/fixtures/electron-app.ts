import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MenuCommand } from '../../src/shared/api';

const repoRoot = resolve(__dirname, '..', '..');

// Hold Playwright's own app-ready release, not a renderer load. Pending gates
// replace handlers at registration, before the app can construct any window.
const bootHandshakeBootstrap = `
const { app, BrowserWindow, ipcMain } = require('electron');
const run = globalThis.__playwright_run;
if (typeof run !== 'function') throw new Error('Playwright boot release unavailable');
globalThis.__playwright_run = () => undefined;
const pending = new Map();
const handlers = ipcMain._invokeHandlers;
const originalSet = handlers.set;
globalThis.__condashBootHandshake = {
  held: true,
  registeredBeforeWindow: false,
  pending,
  deferGate(channel, install) {
    if (!this.held || pending.has(channel)) throw new Error('Invalid pending boot gate: ' + channel);
    if (!pending.size) {
      handlers.set = function(channel, handler) {
        const install = pending.get(channel);
        if (install) {
          pending.delete(channel);
          handler = install(handler);
          if (!pending.size) handlers.set = originalSet;
        }
        return originalSet.call(this, channel, handler);
      };
    }
    pending.set(channel, install);
  },
  resume() {
    if (!this.held || app.isReady() || BrowserWindow.getAllWindows().length) {
      throw new Error('Electron boot handshake released out of order');
    }
    this.held = false;
    globalThis.__playwright_run = run;
    this.ready = run();
  },
};
app.once('browser-window-created', () => {
  globalThis.__condashBootHandshake.registeredBeforeWindow = pending.size === 0;
});
`;

export interface BootedApp {
  app: ElectronApplication;
  window: Page;
  conceptionDir: string;
  userDataDir: string;
  /** Close and relaunch against the same fixture directories. */
  restart(): Promise<{ app: ElectronApplication; window: Page }>;
  cleanup(): Promise<void>;
}

/** Deliver a typed native-menu command to a fixture window. */
export async function sendMenu(app: ElectronApplication, command: MenuCommand): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu-command', value);
  }, command);
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
    /** Extra keys merged into the per-machine global `settings.json` (the
     *  `XDG_CONFIG_HOME/condash/settings.json` the app boots from) — e.g.
     *  `{ dashboard: { enabled: true }, layout: { terminal: true } }`. */
    globalConfig?: Record<string, unknown>;
    prepare?: (conceptionDir: string) => Promise<void>;
    /** Extra env vars merged into the Electron launch — e.g. the
     *  `CONDASH_USER_*` overrides that point the global Skills scope at a
     *  fixture instead of the real `~/.config/agents` etc. */
    env?: Record<string, string>;
    /** Runs on a live main context while Playwright's app-ready release is
     *  held and no window exists. IPC gates are staged before registration;
     *  boot resumes only after the callback finishes, counting every boot read. */
    beforeFirstWindow?: (app: ElectronApplication) => Promise<void>;
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
        ...(options.globalConfig ?? {}),
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
  // The dashboard config falls back to DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL
  // from the environment (config.ts resolveDashboardConfig), so a machine that
  // has them exported would otherwise leak a real key into this throwaway
  // "no API key" test config — the power dot would render `on` instead of
  // `nokey` and the no-key specs would fail here while passing on CI. Strip
  // them so the fixture's no-key premise is actually true on every host.
  const env: Record<string, string | undefined> = {
    ...process.env,
    // Electron honours XDG_CONFIG_HOME for app.getPath('userData') on Linux.
    XDG_CONFIG_HOME: userDataDir,
    CONDASH_FORCE_PROD: '1',
    DEEPSEEK_API_KEY: '',
    DEEPSEEK_BASE_URL: '',
    ...(options.env ?? {}),
  };
  const bootstrapPath = join(userDataDir, 'boot-handshake.cjs');
  if (options.beforeFirstWindow) await writeFile(bootstrapPath, bootHandshakeBootstrap, 'utf8');
  const launch = async (): Promise<{ app: ElectronApplication; window: Page }> => {
    const app = await electron.launch({
      args: [...(options.beforeFirstWindow ? ['-r', bootstrapPath] : []), '.', '--no-sandbox'],
      cwd: repoRoot,
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    });
    try {
      if (options.beforeFirstWindow) {
        const certified = await app.evaluateHandle(({ app, BrowserWindow }) => {
          const boot = (globalThis as any).__condashBootHandshake;
          if (!boot?.held || app.isReady() || BrowserWindow.getAllWindows().length) {
            throw new Error('Electron pre-window boot handshake unavailable');
          }
        });
        await certified.dispose();
        await options.beforeFirstWindow(app);
        const resumed = await app.evaluateHandle(() => {
          (globalThis as any).__condashBootHandshake.resume();
        });
        await resumed.dispose();
      }
      const window = await app.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      if (options.beforeFirstWindow) {
        const registered = await app.evaluateHandle(() => {
          const boot = (globalThis as any).__condashBootHandshake;
          if (boot.pending.size) {
            throw new Error(`Unregistered boot IPC gates: ${[...boot.pending.keys()]}`);
          }
          if (!boot.registeredBeforeWindow)
            throw new Error('IPC gates registered after first window');
        });
        await registered.dispose();
      }

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
      return { app, window };
    } catch (error) {
      await app.close().catch(() => undefined);
      throw error;
    }
  };
  let running: { app: ElectronApplication; window: Page };
  try {
    running = await launch();
  } catch (error) {
    await rm(conceptionDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    app: running.app,
    window: running.window,
    conceptionDir,
    userDataDir,
    restart: async () => {
      await running.app.close();
      running = await launch();
      return running;
    },
    cleanup: async () => {
      await running.app.close().catch(() => undefined);
      await rm(conceptionDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}
