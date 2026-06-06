/**
 * Playwright globalSetup — refuse to open real windows on a Wayland desktop.
 *
 * The headless guarantee is applied by `scripts/run-playwright.mjs` (run via
 * `npm run test` / `make test`), which wraps the run in Xvfb and sets
 * CONDASH_TEST_XVFB. A *direct* `npx playwright test` skips that wrapper, so on
 * Wayland it would render Electron onto the live compositor and steal focus.
 * Abort here — before any worker launches Electron — with guidance instead of
 * popping windows. Visible runs opt in with CONDASH_TEST_HEADED=1.
 */
export default function headlessGuard(): void {
  const headed = process.env.CONDASH_TEST_HEADED === '1';
  const wrapped = process.env.CONDASH_TEST_XVFB === '1';
  const onWayland = process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY);
  if (onWayland && !headed && !wrapped) {
    throw new Error(
      'Refusing to launch Electron onto your live Wayland session — it would open ' +
        'windows and steal focus.\n' +
        'Run the suite headless with `npm run test` or `make test` (both wrap it in ' +
        'Xvfb), or do a visible run with `CONDASH_TEST_HEADED=1 npx playwright test`.',
    );
  }
}
