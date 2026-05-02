import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('app launches and renders the seeded project', async () => {
  const booted = await bootApp();
  try {
    // Workspace landmarks: the edge strips host the persistent pane handles
    // (Projects on the left strip; Code + Knowledge on the right). The
    // Projects handle is always rendered once the renderer mounts.
    await expect(
      booted.window.locator('.edge-strip-left .edge-handle .edge-handle-label').first(),
    ).toHaveText('Projects');
    await expect(booted.window.locator('.row .title').first()).toHaveText('Sample project');
  } finally {
    await booted.cleanup();
  }
});
