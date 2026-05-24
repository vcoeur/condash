/**
 * Agents pane e2e — boots the production build against a fixture conception that
 * carries one opencode agent with a default reasoning effort and one per-agent
 * override. Verifies the simplified card (a single Launch button, click-to-edit),
 * the effort + override selects in the edit view, and the in-editor Delete.
 * Doubles as the manual-verification screenshot source (tests/screenshots-out/agents/).
 */

import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

const outDir = resolve(__dirname, 'screenshots-out', 'agents');

async function seedAgent(conceptionDir: string): Promise<void> {
  const agentsDir = join(conceptionDir, 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    join(agentsDir, 'opencode-deepseek-auto.json'),
    JSON.stringify(
      {
        harness: 'opencode',
        name: 'deepseek-auto',
        slug: 'opencode-deepseek-auto',
        config: {
          model: 'deepseek/deepseek-v4-flash',
          buildModel: 'deepseek/deepseek-v4-pro',
          planModel: 'deepseek/deepseek-v4-pro',
          disableExternalSkills: true,
          effortLevel: 'medium',
          reasoningOverrides: [{ agent: 'plan', effort: 'xhigh' }],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

test('agent card is launch-only and click-to-edit; effort + overrides render', async () => {
  const booted = await bootApp({ prepare: seedAgent });
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1400, height: 900 });
    await window
      .locator('.edge-strip-right')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    await window.locator('.edge-strip-right .edge-handle', { hasText: 'Agents' }).click();

    // One card; its only action is Launch (Config / Edit / Delete are gone).
    const row = window.locator('.agents-row');
    await expect(row).toHaveCount(1);
    const actions = row.locator('.agents-row-actions button');
    await expect(actions).toHaveCount(1);
    await expect(actions).toHaveText('Launch');

    await mkdir(outDir, { recursive: true });
    await window.screenshot({ path: join(outDir, 'agents-card.png') });

    // Clicking the card body opens the edit view.
    await row.locator('.agents-row-main').click();
    const editor = window.locator('.agents-editor');
    await expect(editor).toBeVisible();

    // Default effort select carries the stored value.
    const effortSelect = editor.locator('select').nth(2); // harness, preset, effort
    await expect(effortSelect).toHaveValue('medium');

    // One override row: plan → xhigh.
    const overrideRow = editor.locator('.agents-override-row');
    await expect(overrideRow).toHaveCount(1);
    await expect(overrideRow.locator('select').nth(0)).toHaveValue('plan');
    await expect(overrideRow.locator('select').nth(1)).toHaveValue('xhigh');

    // The live preview reflects both the default and the override.
    const preview = editor.locator('.agents-editor-preview pre');
    await expect(preview).toContainText('"reasoningEffort":"xhigh"');
    await expect(preview).toContainText('"reasoningEffort":"medium"');

    // Delete lives in the editor (confirmed via modal).
    await expect(editor.locator('.agents-editor-delete')).toHaveText('Delete');
    // Scroll the new effort + overrides controls into view for the screenshot.
    await effortSelect.scrollIntoViewIfNeeded();
    await window.screenshot({ path: join(outDir, 'agents-edit.png') });

    // Add a second override and confirm the modal appears on Delete.
    await editor.locator('.agents-overrides button', { hasText: 'Add override' }).click();
    await expect(editor.locator('.agents-override-row')).toHaveCount(2);

    await editor.locator('.agents-editor-delete').click();
    await expect(window.locator('.confirm-modal')).toBeVisible();
    await window.locator('.confirm-modal button', { hasText: 'Cancel' }).click();
    await expect(window.locator('.confirm-modal')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
