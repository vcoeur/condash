/**
 * Agents pane e2e — the editable-slug rename + task cascade. Boots the
 * production build against a fixture conception holding one claude agent and
 * one task that references it by slug. Opens the agent editor from the card,
 * edits the (now editable) slug, saves, and verifies the card shows the new
 * slug; then opens the Tasks pane and verifies the referencing task was
 * repointed (no "missing" badge — the cascade kept it resolving).
 */

import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

async function seed(conceptionDir: string): Promise<void> {
  const agentsDir = join(conceptionDir, 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    join(agentsDir, 'claude-deepseek-v4-pro.json'),
    JSON.stringify(
      {
        harness: 'claude',
        name: 'deepseek-v4-pro',
        slug: 'claude-deepseek-v4-pro',
        secretEnv: 'DEEPSEEK_API_KEY',
        config: {
          baseUrl: 'https://api.deepseek.com/anthropic',
          authStyle: 'bearer',
          model: 'deepseek-chat',
          smallFastModel: 'deepseek-chat',
          haikuAlias: 'deepseek-chat',
          sonnetAlias: 'deepseek-chat',
          opusAlias: 'deepseek-chat',
          subagentModel: 'deepseek-chat',
          maxContextTokens: 131072,
          disableCaching: false,
          disable1M: false,
          disableAdaptiveThinking: false,
          disableTelemetry: true,
          disableErrorReporting: true,
          disableClaudeApiSkill: true,
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const taskDir = join(conceptionDir, 'tasks', 'refresh-app-docs');
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    join(taskDir, 'task.json'),
    JSON.stringify(
      {
        name: 'Refresh app docs',
        agent: 'claude-deepseek-v4-pro',
        submit: true,
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(join(taskDir, 'prompt.md'), 'Review the docs.', 'utf8');
}

test('renaming an agent slug moves the file and cascades to its tasks', async () => {
  const booted = await bootApp({ prepare: seed });
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1400, height: 900 });
    await window
      .locator('.edge-strip-right')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });

    // Open the Agents pane and edit the agent from its card.
    await window.locator('.edge-strip-right .edge-handle', { hasText: 'Agents' }).click();
    await expect(window.locator('.agents-row-slug')).toHaveText('claude-deepseek-v4-pro');
    await window.locator('.agents-row-main').click();
    await expect(window.locator('.modal-backdrop .agents-editor-modal')).toBeVisible();

    // The slug field is editable (no longer frozen on edit). Rename it.
    const editor = window.locator('.agents-editor');
    const slugInput = editor.locator('label').filter({ hasText: 'Slug' }).locator('input');
    await expect(slugInput).toBeEnabled();
    await slugInput.fill('claude-deepseek-renamed');
    await editor.locator('.agents-editor-actions button', { hasText: 'Save' }).click();

    // The card reflects the new slug; the file moved.
    await expect(window.locator('.agents-editor')).toHaveCount(0);
    await expect(window.locator('.agents-row-slug')).toHaveText('claude-deepseek-renamed');

    // The referencing task was repointed (cascade): no "missing" badge, and the
    // badge now shows the new slug.
    await window.locator('.edge-strip-left .edge-handle', { hasText: 'Tasks' }).click();
    await expect(window.locator('.tasks-row')).toHaveCount(1);
    await expect(window.locator('.tasks-agent-missing')).toHaveCount(0);
    await expect(window.locator('.tasks-agent-ok')).toHaveText('claude-deepseek-renamed');
  } finally {
    await cleanup();
  }
});
