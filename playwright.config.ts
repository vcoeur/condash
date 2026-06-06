import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  // Aborts a direct `npx playwright test` on a Wayland desktop before any window
  // can open — the headless wrap lives in scripts/run-playwright.mjs (npm run
  // test), and this catches invocations that skip it. See the guard for detail.
  globalSetup: './tests/fixtures/headless-guard.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Two retries in CI absorb flake from Electron cold-start + xvfb display
  // races that the local box doesn't see. Local runs stay strict (no retry)
  // so flake surfaces in the test author's terminal, not silently absorbed.
  retries: process.env.CI ? 2 : 0,
});
