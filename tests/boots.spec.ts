import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('app launches and renders the seeded project', async () => {
  const booted = await bootApp();
  try {
    // Toolbar landmarks: the three main tabs are always rendered.
    await expect(booted.window.locator('.tabs.main-tabs .tab').first()).toHaveText('Projects');
    await expect(booted.window.locator('.row .title').first()).toHaveText('Sample project');
  } finally {
    await booted.cleanup();
  }
});
