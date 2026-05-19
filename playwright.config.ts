import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
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
