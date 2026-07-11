import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('app launches and renders the seeded project', async () => {
  const booted = await bootApp();
  try {
    // Workspace landmarks: the activity rail hosts the persistent pane items
    // (Projects on the left; Code + Knowledge on the right). The Projects item
    // is always rendered once the renderer mounts.
    await expect(
      booted.window.locator('.rail-item[title*="Projects"]').first(),
    ).toHaveAttribute('title', 'Projects');
    await expect(booted.window.locator('.row .title').first()).toHaveText('Sample project');
  } finally {
    await booted.cleanup();
  }
});
