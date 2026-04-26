import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('app launches and renders the seeded project', async () => {
  const booted = await bootApp();
  try {
    await expect(booted.window.locator('.toolbar h1')).toHaveText('condash');
    await expect(booted.window.locator('.row .title').first()).toHaveText('Sample project');
  } finally {
    await booted.cleanup();
  }
});
