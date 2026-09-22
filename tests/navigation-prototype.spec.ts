import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp, sendMenu } from './fixtures/electron-app';

async function seedNavigationFixture(conceptionDir: string): Promise<void> {
  await writeFile(
    join(conceptionDir, 'projects', '2026-04', '2026-04-26-sample', 'README.md'),
    '# Sample project\n\n## Goal\n\n[[fixture-knowledge]]\n\n## Deliverables\n\n- [Fixture deliverable](fixture-knowledge)\n',
  );
  await writeFile(
    join(conceptionDir, 'knowledge', 'fixture-knowledge.md'),
    '# Fixture knowledge\n',
  );
  await mkdir(join(conceptionDir, 'resources'), { recursive: true });
  await writeFile(join(conceptionDir, 'resources', 'fixture-resource.md'), '# Fixture resource\n');
  await mkdir(join(conceptionDir, '.agents', 'skills', 'fixture-skill'), { recursive: true });
  await writeFile(
    join(conceptionDir, '.agents', 'skills', 'fixture-skill', 'SKILL.md'),
    '# Fixture skill\n',
  );
}

test('navigation prototype keeps reference persistent and utilities session-only', async () => {
  const booted = await bootApp({ prepare: seedNavigationFixture });
  try {
    const { app, window } = booted;
    await expect(window.locator('.rail-item')).toHaveCount(2);
    await expect(window.locator('.rail-item[title="Projects"]')).toBeVisible();
    await expect(window.locator('.rail-item[title^="Code"]')).toBeVisible();

    await sendMenu(app, 'browse-knowledge');
    await expect(window.getByText('Fixture knowledge')).toBeVisible();
    await sendMenu(app, 'browse-resources');
    await expect(window.getByText('Fixture resource')).toBeVisible();
    await sendMenu(app, 'browse-skills');
    await expect(window.getByText('fixture-skill')).toBeVisible();

    const restarted = await booted.restart();
    await expect(restarted.window.getByText('fixture-skill')).toBeVisible();
    await sendMenu(restarted.app, 'show-automations');
    await expect(restarted.window.getByRole('heading', { name: 'Automations' })).toBeVisible();

    const afterAutomationRestart = await booted.restart();
    await expect(afterAutomationRestart.window.getByText('fixture-skill')).toBeVisible();
    await sendMenu(afterAutomationRestart.app, 'show-terminal-diagnostics');
    await expect(afterAutomationRestart.window.getByText('Terminal diagnostics')).toBeVisible();
    await mkdir('tests/screenshots-out/navigation', { recursive: true });
    await afterAutomationRestart.window.screenshot({
      path: 'tests/screenshots-out/navigation/terminal-diagnostics.png',
    });
    await sendMenu(afterAutomationRestart.app, 'show-session-logs');
    await expect(afterAutomationRestart.window.getByText('Logs')).toBeVisible();
  } finally {
    await booted.cleanup();
  }
});
