/**
 * Agents pane e2e — boots the production build against a fixture conception that
 * carries one opencode agent with named variants, a default variant, and one
 * per-agent variant override. Verifies the simplified card (a single Launch
 * button, click-to-edit), that the editor opens as a popup modal, the variant
 * editor + default-variant + per-agent controls, and the in-editor Delete.
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
          model: 'deepseek/deepseek-v4-pro',
          disableExternalSkills: true,
          variants: [
            { name: 'deep', reasoningEffort: 'xhigh', reasoningSummary: 'auto' },
            { name: 'fast', reasoningEffort: 'low', textVerbosity: 'low' },
          ],
          defaultVariant: 'fast',
          agentOverrides: [{ agent: 'plan', model: 'deepseek/deepseek-v4-flash', variant: 'deep' }],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

test('agent card is launch-only; editor is a popup with variants + default variant', async () => {
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

    // Clicking the card body opens the edit view as a popup modal.
    await row.locator('.agents-row-main').click();
    await expect(window.locator('.modal-backdrop .agents-editor-modal')).toBeVisible();
    const editor = window.locator('.agents-editor');
    await expect(editor).toBeVisible();

    // Two named variants; the first row's name is "deep".
    const variantRows = editor.locator('.agents-variant-row');
    await expect(variantRows).toHaveCount(2);
    await expect(variantRows.nth(0).locator('.agents-variant-name')).toHaveValue('deep');

    // Default variant select carries the stored value.
    const defaultSelect = editor.locator('label', { hasText: 'Default variant' }).locator('select');
    await expect(defaultSelect).toHaveValue('fast');

    // One per-agent override: plan → its own model + the deep variant.
    const overrideRow = editor.locator('.agents-override-row');
    await expect(overrideRow).toHaveCount(1);
    await expect(overrideRow.locator('select').nth(0)).toHaveValue('plan'); // agent
    await expect(overrideRow.locator('input')).toHaveValue('deepseek/deepseek-v4-flash'); // model
    await expect(overrideRow.locator('select').nth(1)).toHaveValue('deep'); // variant

    // The live preview reflects variants + per-agent model/variant + the default.
    const preview = editor.locator('.agents-editor-preview pre');
    await expect(preview).toContainText('"variants"');
    await expect(preview).toContainText('"reasoningEffort":"xhigh"');
    await expect(preview).toContainText('"model":"deepseek/deepseek-v4-flash"'); // plan model
    await expect(preview).toContainText('"variant":"deep"'); // plan variant
    await expect(preview).toContainText('"variant":"fast"'); // default on other agents

    await variantRows.first().scrollIntoViewIfNeeded();
    await window.screenshot({ path: join(outDir, 'agents-edit.png') });

    // Typing in a variant-name input must NOT lose focus per keystroke
    // (regression: `<For>` re-created the row → now `<Index>`). Use a fresh
    // scratch variant so the referenced ones above stay intact.
    await editor.locator('.agents-overrides button', { hasText: 'Add variant' }).click();
    const scratchName = editor
      .locator('.agents-variant-row')
      .last()
      .locator('.agents-variant-name');
    await scratchName.click();
    await scratchName.pressSequentially('scratch');
    await expect(scratchName).toBeFocused();
    await expect(scratchName).toHaveValue('scratch');

    // Delete lives in the editor, confirmed via a modal.
    await expect(editor.locator('.agents-editor-delete')).toHaveText('Delete');
    await editor.locator('.agents-editor-delete').click();
    await expect(window.locator('.confirm-modal')).toBeVisible();
    await window.locator('.confirm-modal button', { hasText: 'Cancel' }).click();
    await expect(window.locator('.confirm-modal')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
