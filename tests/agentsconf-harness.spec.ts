/**
 * Agents pane e2e — the launch-only `agentsconf` harness. Boots the production
 * build, creates a new agent with harness "agentsconf", confirms the editor
 * shows a Binary field and hides the token field, saves, and verifies the card
 * lists the binary as its launch command under the agentsconf group.
 */

import { test, expect } from '@playwright/test';
import { bootApp } from './fixtures/electron-app';

test('creates an agentsconf agent that launches a bare binary', async () => {
  const booted = await bootApp();
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1400, height: 900 });
    await window
      .locator('.edge-strip-right')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });

    // Open the Agents pane and start a new agent.
    await window.locator('.edge-strip-right .edge-handle', { hasText: 'Agents' }).click();
    await window.locator('.agents-pane-actions button', { hasText: '+ New agent' }).click();
    const editor = window.locator('.agents-editor');
    await expect(editor).toBeVisible();

    // Switch to the agentsconf harness.
    await editor
      .locator('label')
      .filter({ hasText: 'Harness' })
      .locator('select')
      .selectOption('agentsconf');

    // The token field is hidden for agentsconf; a single Binary field appears.
    await expect(editor.locator('label').filter({ hasText: 'Token env var' })).toHaveCount(0);
    const binaryInput = editor.locator('label').filter({ hasText: 'Binary' }).locator('input');
    await expect(binaryInput).toBeVisible();

    // Fill name + binary; the preview shows the bare binary.
    await editor
      .locator('label')
      .filter({ hasText: 'Name (display label)' })
      .locator('input')
      .fill('DeepSeek Auto');
    await binaryInput.fill('claude-deepseek-auto');
    await expect(editor.locator('.agents-editor-preview pre')).toContainText(
      'claude-deepseek-auto',
    );
    await editor.locator('.agents-editor-actions button', { hasText: 'Save' }).click();

    // The card lists under the agentsconf group with the binary as its command.
    await expect(window.locator('.agents-editor')).toHaveCount(0);
    await expect(
      window.locator('.agents-group h3').filter({ hasText: 'agentsconf' }),
    ).toBeVisible();
    await expect(window.locator('.agents-row-cmd')).toHaveText('claude-deepseek-auto');
  } finally {
    await cleanup();
  }
});
