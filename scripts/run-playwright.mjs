#!/usr/bin/env node
/**
 * Headless-by-default Playwright runner — the canonical way to run the suite.
 *
 * A test run must NEVER open Electron windows onto the developer's screen. On a
 * Wayland desktop Electron renders to the live compositor (WAYLAND_DISPLAY) — or
 * to XWayland via DISPLAY — and steals focus mid-run. Electron also cannot
 * attach to Playwright under a true offscreen backend (`--ozone-platform=
 * headless`), so the reliable recipe is a throwaway Xvfb display with the
 * Wayland socket dropped and the X11 Ozone backend pinned. This wrapper applies
 * that recipe to the whole run, so `npm run test` / `make test` stay headless
 * regardless of how they were invoked. (The globalSetup guard in
 * tests/fixtures/headless-guard.ts catches a *direct* `npx playwright test`
 * that skips this wrapper.)
 *
 * Opt into a visible, on-screen run with CONDASH_TEST_HEADED=1. Extra args are
 * forwarded to `playwright test` (e.g. `npm run test -- spawn-dropdown`).
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const run = (cmd, cmdArgs, env) =>
  spawnSync(cmd, cmdArgs, { stdio: 'inherit', env: env ?? process.env });

let result;
if (process.env.CONDASH_TEST_HEADED === '1' || process.platform !== 'linux') {
  // Visible run, or a platform without the Wayland-window problem (macOS /
  // Windows). Run Playwright directly.
  result = run(npx, ['playwright', 'test', ...args]);
} else {
  // Headless on Linux: render into a throwaway Xvfb display, never the live
  // compositor. `env -u WAYLAND_DISPLAY ELECTRON_OZONE_PLATFORM_HINT=x11` stops
  // Electron falling back onto Wayland; CONDASH_TEST_XVFB tells the globalSetup
  // guard this run is safely wrapped.
  result = run(
    'xvfb-run',
    [
      '-a',
      'env',
      '-u',
      'WAYLAND_DISPLAY',
      'ELECTRON_OZONE_PLATFORM_HINT=x11',
      npx,
      'playwright',
      'test',
      ...args,
    ],
    { ...process.env, CONDASH_TEST_XVFB: '1' },
  );
  if (result.error && result.error.code === 'ENOENT') {
    console.error(
      '\nrun-playwright: `xvfb-run` not found — cannot run headless.\n' +
        'Install it (e.g. `sudo apt install xvfb`) or run a visible suite with\n' +
        '`CONDASH_TEST_HEADED=1 npm run test`. Refusing to open windows on your screen.\n',
    );
    process.exit(1);
  }
}
process.exit(result.status ?? 1);
