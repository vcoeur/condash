/**
 * Tasks pane e2e — boots the production build against a fixture conception that
 * carries one agent and one task, opens the Tasks pane from its own left
 * edge-strip handle (a peer of Projects / Deliverables), verifies the card +
 * marker chips, then opens the fill view and checks the app picker plus the
 * live preview substitution. Doubles as the manual-verification screenshot
 * source (tests/screenshots-out/tasks/).
 */

import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

const outDir = resolve(__dirname, 'screenshots-out', 'tasks');

/** The agent the seeded task references — passed via `extraConfig.agents` so
 *  the task's reference resolves (Run enabled, no "missing" badge). */
const TASK_AGENT = { id: 'claude-deepseek-v4-pro', label: 'deepseek-v4-pro', command: 'claude' };

async function seedTask(conceptionDir: string): Promise<void> {
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
  await writeFile(
    join(taskDir, 'prompt.md'),
    'Review {APP} and update its docs. Focus: {AREA:CLAUDE.md and docs/}',
    'utf8',
  );
}

test('tasks pane lists a task and fills its markers', async () => {
  const booted = await bootApp({
    prepare: seedTask,
    extraConfig: {
      agents: [TASK_AGENT],
      repositories: [{ name: 'condash', path: '/home/alice/src/vcoeur/condash' }],
    },
  });
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1400, height: 900 });
    await window.locator('.edge-strip-left').first().waitFor({ state: 'visible', timeout: 10_000 });

    // Open the Tasks pane from its own left edge-strip handle.
    await window.locator('.edge-strip-left .edge-handle', { hasText: 'Tasks' }).click();

    // One card, named, with the parsed marker chips (one app picker, one field).
    const rows = window.locator('.tasks-row');
    await expect(rows).toHaveCount(1);
    await expect(window.locator('.tasks-row-name')).toHaveText('Refresh app docs');
    await expect(window.locator('.tasks-marker[data-kind="app"]')).toHaveText('{APP}');
    await expect(window.locator('.tasks-marker[data-kind="field"]')).toHaveText('{AREA}');
    // Agent resolves → no "missing" badge, Run enabled.
    await expect(window.locator('.tasks-agent-missing')).toHaveCount(0);
    // The card carries a single action — Run… — and nothing else (edit/delete
    // moved into the editor popup).
    const cardActions = rows.locator('.tasks-row-actions button');
    await expect(cardActions).toHaveCount(1);
    await expect(cardActions).toHaveText('Run…');

    await mkdir(outDir, { recursive: true });
    await window.screenshot({ path: join(outDir, 'tasks-pane.png') });

    // The Run… button opens the fill as a popup modal; the {APP} picker and the
    // {AREA} field render.
    await window.locator('.tasks-row-actions button', { hasText: 'Run…' }).click();
    await expect(window.locator('.modal-backdrop .tasks-fill-modal')).toBeVisible();
    await expect(window.locator('.tasks-fill')).toBeVisible();

    // The run-time Agent picker sits in the top control row and defaults to the
    // task's stored agent id (overridable per run).
    await expect(window.locator('.tasks-fill-top select')).toHaveValue('claude-deepseek-v4-pro');

    // The {AREA} field is prefilled from its default; the preview echoes it.
    const preview = window.locator('.tasks-preview pre');
    await expect(preview).toContainText('Focus: CLAUDE.md and docs/');
    // {APP} is unfilled → left verbatim until an app is picked.
    await expect(preview).toContainText('{APP}');

    // Pick the seeded app → bare {APP} resolves to its #alias in the preview.
    // The app picker is the first select in the scroll body (the agent picker
    // lives in the top control row, not here).
    await window.locator('.tasks-fill-scroll select').first().selectOption('#condash');
    await expect(preview).toContainText('Review #condash');

    await window.screenshot({ path: join(outDir, 'tasks-fill.png') });
  } finally {
    await cleanup();
  }
});

test('new task editor creates a task end-to-end', async () => {
  const booted = await bootApp({ prepare: seedTask, extraConfig: { agents: [TASK_AGENT] } });
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1400, height: 900 });
    await window.locator('.edge-strip-left').first().waitFor({ state: 'visible', timeout: 10_000 });
    await window.locator('.edge-strip-left .edge-handle', { hasText: 'Tasks' }).click();

    await window.locator('.tasks-pane-actions button', { hasText: 'New task' }).click();
    await expect(window.locator('.modal-backdrop .tasks-editor-modal')).toBeVisible();
    const editor = window.locator('.tasks-editor');
    await expect(editor).toBeVisible();

    // Name drives the slug for a new task; the prompt's markers chip live.
    await editor.locator('input[type="text"]').first().fill('Triage incident');
    await editor.locator('textarea').fill('Triage {PROJECT} on {SEVERITY:high}');
    await expect(editor.locator('.tasks-marker[data-kind="project"]')).toHaveText('{PROJECT}');

    await mkdir(outDir, { recursive: true });
    await window.screenshot({ path: join(outDir, 'tasks-editor.png') });

    await editor.locator('button', { hasText: 'Save' }).click();

    // The new card joins the list (sorted by name: Refresh app docs, Triage incident).
    await expect(window.locator('.tasks-row')).toHaveCount(2);
    await expect(window.locator('.tasks-row-name').nth(1)).toHaveText('Triage incident');
  } finally {
    await cleanup();
  }
});

test('clicking a card opens the editor; delete is confirmed and removes the task', async () => {
  const booted = await bootApp({ prepare: seedTask, extraConfig: { agents: [TASK_AGENT] } });
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1400, height: 900 });
    await window.locator('.edge-strip-left').first().waitFor({ state: 'visible', timeout: 10_000 });
    await window.locator('.edge-strip-left .edge-handle', { hasText: 'Tasks' }).click();

    await expect(window.locator('.tasks-row')).toHaveCount(1);

    // Clicking the card body (not the Run… button) opens the editor popup modal.
    await window.locator('.tasks-row-main').click();
    await expect(window.locator('.modal-backdrop .tasks-editor-modal')).toBeVisible();
    const editor = window.locator('.tasks-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('input[type="text"]').first()).toHaveValue('Refresh app docs');

    // Delete lives in the editor and is confirmed via a modal before it fires.
    await expect(editor.locator('.tasks-editor-delete')).toHaveText('Delete');
    await editor.locator('.tasks-editor-delete').click();
    await expect(window.locator('.confirm-modal')).toBeVisible();
    await window.locator('.confirm-modal button', { hasText: 'Delete' }).click();

    // Editor closes and the card is gone.
    await expect(window.locator('.tasks-editor')).toHaveCount(0);
    await expect(window.locator('.tasks-row')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
