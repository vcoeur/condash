/**
 * Playwright globalSetup — refuse to open real windows on a Linux desktop.
 *
 * The headless guarantee is applied by `scripts/run-playwright.mjs` (run via
 * `npm run test` / `make test`), which wraps the run in Xvfb and sets
 * CONDASH_TEST_XVFB. A *direct* `npx playwright test` skips that wrapper, so on
 * Wayland it would render Electron onto the live compositor (WAYLAND_DISPLAY)
 * and on plain X11 onto the live X server (DISPLAY) — opening windows and
 * stealing focus either way. Abort here — before any worker launches Electron —
 * with guidance instead of popping windows. The wrapper's own Xvfb child also
 * has DISPLAY set (the throwaway virtual display), but it carries
 * CONDASH_TEST_XVFB=1, so wrapped runs pass. Visible runs opt in with
 * CONDASH_TEST_HEADED=1.
 */
export default function headlessGuard(): void {
  const headed = process.env.CONDASH_TEST_HEADED === '1';
  const wrapped = process.env.CONDASH_TEST_XVFB === '1';
  const onLinuxDisplay =
    process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
  if (onLinuxDisplay && !headed && !wrapped) {
    throw new Error(
      'Refusing to launch Electron onto your live display session (Wayland or X11) — ' +
        'it would open windows and steal focus.\n' +
        'Run the suite headless with `npm run test` or `make test` (both wrap it in ' +
        'Xvfb), or do a visible run with `CONDASH_TEST_HEADED=1 npx playwright test`.',
    );
  }
}
