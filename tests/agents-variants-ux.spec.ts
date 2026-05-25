/**
 * Agents pane e2e — boots the production build against a fixture conception that
 * carries one opencode agent configured via the per-agent options table (a
 * default row + a plan row on its own model). Verifies the launch-only
 * click-to-edit card, the popup modal, the options table (default + per-agent
 * rows with model/effort/verbosity/summary + a primary toggle), that a built-in
 * row's primary toggle is checked-and-disabled, that a new custom row is a
 * primary emitting mode:"primary", that typing in a row cell keeps focus, the
 * options preview, and the confirmed in-editor Delete.
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
          defaultOptions: { reasoningEffort: 'medium' },
          agentOptions: [
            { agent: 'plan', model: 'kimi-for-coding/kimi-k2-thinking', reasoningEffort: 'high' },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

test('agent card opens a popup options table; rows + focus + variant preview', async () => {
  const booted = await bootApp({ prepare: seedAgent });
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1400, height: 900 });
    await window
      .locator('.edge-strip-right')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    await window.locator('.edge-strip-right .edge-handle', { hasText: 'Agents' }).click();

    // One card; its only action is Launch.
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

    // Options table: head row + default row + one per-agent (plan) row.
    const rows = editor.locator('.agents-option-row');
    await expect(rows).toHaveCount(3);
    await expect(editor.locator('.agents-option-default')).toHaveText('(default)');

    // Default row: model = the default model, effort = medium.
    const defaultRow = rows.nth(1);
    await expect(defaultRow.locator('input')).toHaveValue('deepseek/deepseek-v4-pro');
    await expect(defaultRow.locator('select').nth(0)).toHaveValue('medium'); // effort

    // Plan row: agent = plan (a built-in primary → its primary toggle is checked
    // and disabled, since condash never overrides a built-in's mode), its own
    // model, effort = high.
    const planRow = rows.nth(2);
    await expect(planRow.locator('.agents-option-agent')).toHaveValue('plan'); // agent name
    const planPrimary = planRow.locator('.agents-option-primary input');
    await expect(planPrimary).toBeChecked();
    await expect(planPrimary).toBeDisabled();
    await expect(planRow.locator('input[placeholder="inherit default"]')).toHaveValue(
      'kimi-for-coding/kimi-k2-thinking',
    ); // model
    await expect(planRow.locator('select').nth(0)).toHaveValue('high'); // effort

    // The live preview shows plain options: the default on the model base, plan's
    // own model + options. (No variants — opencode footer ignores those anyway.)
    const preview = editor.locator('.agents-editor-preview pre');
    await expect(preview).not.toContainText('"variants"');
    await expect(preview).toContainText('"options":{"reasoningEffort":"medium"'); // default → model base
    await expect(preview).toContainText('"reasoningEffort":"high"'); // plan
    await expect(preview).toContainText('"model":"kimi-for-coding/kimi-k2-thinking"'); // plan model

    await rows.first().scrollIntoViewIfNeeded();
    await window.screenshot({ path: join(outDir, 'agents-edit.png') });

    // Add a custom agent row: it starts as a primary (toggle checked + enabled).
    await editor.locator('.agents-overrides button', { hasText: 'Add agent' }).click();
    const newRow = editor.locator('.agents-option-row').last();
    const newPrimary = newRow.locator('.agents-option-primary input');
    await expect(newPrimary).toBeChecked();
    await expect(newPrimary).toBeEnabled();

    // Typing in a row cell must NOT lose focus per keystroke (Index, not For).
    const newName = newRow.locator('.agents-option-agent');
    await newName.click();
    await newName.pressSequentially('deep');
    await expect(newName).toBeFocused();
    await expect(newName).toHaveValue('deep');
    const newModel = newRow.locator('input[placeholder="inherit default"]');
    await newModel.click();
    await newModel.pressSequentially('deepseek/x');
    await expect(newModel).toBeFocused();
    await expect(newModel).toHaveValue('deepseek/x');

    // A custom primary row serializes agent.<name>.mode = "primary" (it also picks
    // up the default options onto its model, asserted elsewhere — match just the mode).
    await expect(preview).toContainText('"deep":{"mode":"primary"');

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
