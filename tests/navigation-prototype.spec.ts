import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp, sendMenu } from './fixtures/electron-app';

async function seedNavigationFixture(conceptionDir: string): Promise<void> {
  await writeFile(
    join(conceptionDir, 'projects', '2026-04', '2026-04-26-sample', 'README.md'),
    '# Sample project\n\n**Status**: now\n**Kind**: project\n\n## Goal\n\nGoal.\n\n## Deliverables\n\n- [[fixture-knowledge|Fixture deliverable]]\n',
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

/** Every rail item by label, in rail order. */
const RAIL_LABELS = ['Projects', 'Code', 'Knowledge', 'Resources', 'Skills', 'Automations', 'Logs'];

function railItem(window: import('@playwright/test').Page, label: string) {
  // `Code` carries a shortcut in its tooltip ("Code (Ctrl+Shift+C)"), so
  // match on the label prefix rather than the exact title.
  return window.locator(`.rail-item[title^="${label}"]`).first();
}

test('the rail is the complete navigation — one click swaps any right pane', async () => {
  // Four Electron boots (initial + three restarts) plus the in-page waits
  // overrun the 30 s default; repo convention for boot-heavy specs is 90 s.
  test.setTimeout(90_000);
  const booted = await bootApp({
    prepare: seedNavigationFixture,
    extraConfig: { repositories: ['fixture-repo'] },
  });
  try {
    const { app, window } = booted;

    // The rail carries all seven items, in order, with Projects first.
    const items = window.locator('.rail-item');
    await expect(items).toHaveCount(7);
    for (const label of RAIL_LABELS) {
      await expect(railItem(window, label)).toBeVisible({ timeout: 10_000 });
    }
    await expect(items.nth(0)).toHaveAttribute('title', 'Projects');
    await expect(items.nth(1)).toHaveAttribute('title', 'Code (Ctrl+Shift+C)');
    await expect(items.nth(6)).toHaveAttribute('title', 'Logs');

    // The default working surface is Code; Projects is always visible.
    await expect(railItem(window, 'Projects')).toHaveAttribute('aria-pressed', 'true');
    await expect(railItem(window, 'Code')).toHaveAttribute('aria-pressed', 'true');
    await expect(window.locator('.repos-pane')).toBeVisible();
    await expect(window.locator('.projects-pane')).toBeVisible();

    // Direct one-click switch Code → Knowledge and back: no close-first
    // step, exactly one working pane at a time.
    await railItem(window, 'Knowledge').click();
    await expect(window.getByText('Fixture knowledge')).toBeVisible();
    await expect(window.locator('.repos-pane')).toHaveCount(0);
    await expect(railItem(window, 'Knowledge')).toHaveAttribute('aria-pressed', 'true');
    await expect(railItem(window, 'Code')).toHaveAttribute('aria-pressed', 'false');
    await railItem(window, 'Code').click();
    await expect(window.locator('.repos-pane')).toBeVisible();
    await expect(window.getByText('Fixture knowledge')).toHaveCount(0);

    // The rail covers every surface: resources, skills, automations, logs —
    // each a single click away, each replacing the pane before it.
    await railItem(window, 'Resources').click();
    await expect(window.getByText('Fixture resource')).toBeVisible();
    await railItem(window, 'Skills').click();
    await expect(window.getByText('fixture-skill')).toBeVisible();
    await railItem(window, 'Automations').click();
    await expect(window.getByRole('heading', { name: 'Automations' })).toBeVisible();
    await railItem(window, 'Logs').click();
    await expect(window.locator('.logs-pane')).toBeVisible();
    // …and switching back to Code works from the far end of the rail too.
    await railItem(window, 'Code').click();
    await expect(window.locator('.repos-pane')).toBeVisible();

    // View → Working pane mirrors the rail with direct selections.
    await sendMenu(app, 'show-logs');
    await expect(window.locator('.logs-pane')).toBeVisible();
    await sendMenu(app, 'show-automations');
    await expect(window.getByRole('heading', { name: 'Automations' })).toBeVisible();
    await sendMenu(app, 'show-knowledge');
    await expect(window.getByText('Fixture knowledge')).toBeVisible();

    // The selection persists across a restart — including the re-added
    // logs and automations surfaces.
    await sendMenu(app, 'show-logs');
    await expect(window.locator('.logs-pane')).toBeVisible();
    const restartedOnLogs = await booted.restart();
    await expect(restartedOnLogs.window.locator('.logs-pane')).toBeVisible();
    await sendMenu(restartedOnLogs.app, 'show-automations');
    await expect(
      restartedOnLogs.window.getByRole('heading', { name: 'Automations' }),
    ).toBeVisible();
    const restartedOnAutomations = await booted.restart();
    await expect(
      restartedOnAutomations.window.getByRole('heading', { name: 'Automations' }),
    ).toBeVisible();
    await expect(restartedOnAutomations.window.locator('.logs-pane')).toHaveCount(0);

    // Terminal stays the bottom band: the rail has no Terminal item; the
    // menu toggle and the strip handle both work.
    await expect(railItem(restartedOnAutomations.window, 'Terminal')).toHaveCount(0);
    await sendMenu(restartedOnAutomations.app, 'toggle-terminal');
    await expect(restartedOnAutomations.window.locator('.terminal-pane')).toHaveClass(/closed/);
    await sendMenu(restartedOnAutomations.app, 'toggle-terminal');
    await expect(restartedOnAutomations.window.locator('.terminal-pane')).not.toHaveClass(/closed/);

    // Terminal diagnostics remains a View → Troubleshooting route into the
    // bottom band, session-only (not a rail item, not persisted).
    await sendMenu(restartedOnAutomations.app, 'show-terminal-diagnostics');
    await expect(restartedOnAutomations.window.getByText('Terminal diagnostics')).toBeVisible();
    const afterDiagnostics = await booted.restart();
    await expect(afterDiagnostics.window.locator('.terminal-pane.diagnostics-active')).toHaveCount(
      0,
    );

    // Item deliverables still render in the project preview, and a
    // deliverable wikilink resolves lazily against the Knowledge tree even
    // though it was never loaded at boot.
    await sendMenu(afterDiagnostics.app, 'show-code');
    // Sections persist their collapsed state in localStorage across the
    // restarts above; start from all-open so the seeded `now` card is there.
    await afterDiagnostics.window.evaluate(() => {
      window.localStorage.setItem('condash:projects:section-collapse', JSON.stringify({}));
    });
    await afterDiagnostics.window.reload();
    await afterDiagnostics.window.waitForLoadState('domcontentloaded');
    // The Projects pane renders as soon as the list IPC resolves; poll for
    // the card rather than racing a fixed wait.
    await expect(afterDiagnostics.window.locator('article.row .title-text')).toHaveText(
      ['Sample project'],
      { timeout: 20_000 },
    );
    const sampleCard = afterDiagnostics.window.locator('.row .title-text').first();
    await expect(sampleCard).toBeVisible({ timeout: 15_000 });
    await sampleCard.click();
    await expect(afterDiagnostics.window.locator('.modal.project-preview')).toBeVisible();
    await expect(
      afterDiagnostics.window.locator('.modal.project-preview .deliverable-row'),
    ).toHaveCount(1);
    await afterDiagnostics.window
      .locator('.modal.project-preview .deliverable-row .deliverable-button')
      .first()
      .click();
    await expect(afterDiagnostics.window.getByText('Fixture knowledge')).toBeVisible();

    await mkdir('tests/screenshots-out/navigation', { recursive: true });
    await afterDiagnostics.window.screenshot({
      path: 'tests/screenshots-out/navigation/rail-full-map.png',
    });
  } finally {
    await booted.cleanup();
  }
});
