import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
const RAIL_LABELS = ['Projects', 'Code', 'Knowledge', 'Resources', 'Skills', 'Terminal'];

test('three rail groups toggle independently and preserve hidden layouts on reload', async () => {
  test.setTimeout(90_000);
  const booted = await bootApp({ prepare: seedNavigationFixture });
  try {
    let { window, app } = booted;
    await expect(window.locator('.rail-divider')).toHaveCount(2);
    expect(
      await window
        .locator('.rail')
        .evaluate((rail) =>
          Array.from(rail.children).map((child) =>
            child.classList.contains('rail-divider')
              ? 'separator'
              : child.getAttribute('title')?.split(' (')[0],
          ),
        ),
    ).toEqual([
      'Projects',
      'separator',
      'Code',
      'Knowledge',
      'Resources',
      'Skills',
      'separator',
      'Terminal',
    ]);
    await railItem(window, 'Projects').click();
    await expect(railItem(window, 'Projects')).toHaveAttribute('aria-pressed', 'false');
    for (const label of ['Code', 'Knowledge', 'Resources', 'Skills']) {
      await sendMenu(app, `show-${label.toLowerCase()}` as 'show-code');
      await expect(railItem(window, label)).toHaveAttribute('aria-pressed', 'true');
      await sendMenu(app, `show-${label.toLowerCase()}` as 'show-code');
      await expect(railItem(window, label)).toHaveAttribute('aria-pressed', 'true');
      await expect(railItem(window, 'Projects')).toHaveAttribute('aria-pressed', 'false');
      const band = await window.locator('.top-band').boundingBox();
      const workingPane = await window.locator('.pane-working').boundingBox();
      expect(workingPane?.width).toBe(band?.width);
      await railItem(window, label).click();
      await expect(railItem(window, label)).toHaveAttribute('aria-pressed', 'false');
      await expect(window.locator('.top-band')).toBeHidden();
      await railItem(window, label).click();
      await expect(railItem(window, label)).toHaveAttribute('aria-pressed', 'true');
    }
    await railItem(window, 'Skills').click();
    await expect(window.locator('.top-band')).toBeHidden();
    await expect(window.locator('.terminal-pane')).not.toHaveClass(/closed/);
    ({ window, app } = await booted.restart());
    await expect(railItem(window, 'Projects')).toHaveAttribute('aria-pressed', 'false');
    await expect(window.locator('.top-band')).toBeHidden();
    await railItem(window, 'Terminal').click();
    await expect(window.locator('.terminal-pane')).toHaveClass(/closed/);
    ({ window, app } = await booted.restart());
    await expect(window.locator('.top-band')).toBeHidden();
    await expect(window.locator('.terminal-pane')).toHaveClass(/closed/);
    await railItem(window, 'Projects').click();
    await expect(window.locator('.pane-projects')).toBeVisible();
    await expect(window.locator('.top-band-splitter')).toBeHidden();
    const projectsBand = await window.locator('.top-band').boundingBox();
    const projectsPane = await window.locator('.pane-projects').boundingBox();
    expect(projectsPane?.width).toBe(projectsBand?.width);
    await railItem(window, 'Knowledge').click();
    await expect(window.locator('.top-band-splitter')).toBeVisible();
    await railItem(window, 'Resources').click();
    await expect(railItem(window, 'Knowledge')).toHaveAttribute('aria-pressed', 'false');
    await expect(railItem(window, 'Projects')).toHaveAttribute('aria-pressed', 'true');
    await railItem(window, 'Terminal').click();
    await sendMenu(app, 'search');
    await window.locator('.search-modal-input').fill('Fixture resource');
    await window.locator('.search-row').filter({ hasText: 'Fixture resource' }).first().click();
    await expect(window.locator('.modal.note-modal')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(railItem(window, 'Resources')).toHaveAttribute('aria-pressed', 'true');
    await window.mouse.move(1200, 20);
    await window.screenshot({ path: 'test-results/rail-groups-and-toggles.png' });
  } finally {
    await booted.cleanup();
  }
});

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

    // The rail carries four working panes plus Projects and Terminal.
    const items = window.locator('.rail-item');
    await expect(items).toHaveCount(6);
    for (const label of RAIL_LABELS) {
      await expect(railItem(window, label)).toBeVisible({ timeout: 10_000 });
    }
    await expect(items.nth(0)).toHaveAttribute('title', 'Projects');
    await expect(items.nth(1)).toHaveAttribute('title', 'Code (Ctrl+Shift+C)');
    await expect(items.nth(5)).toHaveAttribute('title', 'Terminal');
    await expect(
      window.locator('.rail-item[title="Automations"], .rail-item[title="Logs"]'),
    ).toHaveCount(0);
    const viewLabels = await app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View');
      return view?.submenu?.items.flatMap((item) => [
        item.label,
        ...(item.submenu?.items.map((child) => child.label) ?? []),
      ]);
    });
    expect(viewLabels).not.toEqual(expect.arrayContaining(['Show Automations']));
    expect(viewLabels).not.toEqual(expect.arrayContaining(['Show Logs']));
    expect(viewLabels).not.toEqual(expect.arrayContaining(['Terminal diagnostics']));

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
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await expect(window.getByRole('heading', { name: 'Automations' })).toBeVisible();
    await window.locator('.surface-back').click();
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.logs-pane')).toBeVisible();
    // …and switching back to Code works from the far end of the rail too.
    await window.locator('.surface-back').click();
    await railItem(window, 'Code').click();
    await expect(window.locator('.repos-pane')).toBeVisible();

    // View → Working pane mirrors the rail with direct selections.
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.logs-pane')).toBeVisible();
    await window.keyboard.press('Escape');
    await window.getByRole('button', { name: 'Automations', exact: true }).click();
    await expect(window.getByRole('heading', { name: 'Automations' })).toBeVisible();
    await window.keyboard.press('Escape');
    await sendMenu(app, 'show-knowledge');
    await expect(window.getByText('Fixture knowledge')).toBeVisible();

    // Working-pane selection persists; utility overlays do not reopen on restart.
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.logs-pane')).toBeVisible();
    const restartedOnLogs = await booted.restart();
    await expect(restartedOnLogs.window.locator('.logs-pane')).toHaveCount(0);
    await expect(restartedOnLogs.window.getByText('Fixture knowledge')).toBeVisible();
    await restartedOnLogs.window.getByRole('button', { name: 'Automations', exact: true }).click();
    await expect(
      restartedOnLogs.window.getByRole('heading', { name: 'Automations' }),
    ).toBeVisible();
    const restartedOnAutomations = await booted.restart();
    await expect(restartedOnAutomations.window.locator('.surface-overlay')).toHaveCount(0);
    await expect(restartedOnAutomations.window.locator('.logs-pane')).toHaveCount(0);

    // Terminal is a bottom-band toggle, not another right-pane surface.
    const terminalRail = railItem(restartedOnAutomations.window, 'Terminal');
    const terminalPane = restartedOnAutomations.window.locator('.terminal-pane');
    await terminalRail.click();
    await expect(terminalPane).toHaveClass(/closed/);
    await expect(terminalRail).toHaveAttribute('aria-pressed', 'false');
    await expect(restartedOnAutomations.window.getByText('Fixture knowledge')).toBeVisible();
    await terminalRail.click();
    await expect(terminalPane).not.toHaveClass(/closed/);
    await expect(terminalRail).toHaveAttribute('aria-pressed', 'true');
    // Invoke the native View item itself, not merely the same IPC command.
    await restartedOnAutomations.app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View');
      const toggle = view?.submenu?.items.find((item) => item.label === 'Show Terminal');
      if (!toggle?.click) throw new Error('View → Show Terminal is missing');
      toggle.click(toggle, undefined, undefined);
    });
    await expect(terminalPane).toHaveClass(/closed/);
    await expect(terminalRail).toHaveAttribute('aria-pressed', 'false');
    await restartedOnAutomations.app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View');
      const toggle = view?.submenu?.items.find((item) => item.label === 'Show Terminal');
      if (!toggle?.click) throw new Error('View → Show Terminal is missing');
      toggle.click(toggle, undefined, undefined);
    });
    await expect(terminalPane).not.toHaveClass(/closed/);

    // Diagnostics is a session-only full-window overlay, not a terminal body.
    await restartedOnAutomations.window
      .getByRole('button', { name: 'Diagnostics', exact: true })
      .click();
    await expect(restartedOnAutomations.window.getByText('Terminal diagnostics')).toBeVisible();
    await expect(restartedOnAutomations.window.locator('.surface-overlay')).toHaveAttribute(
      'aria-label',
      'Diagnostics',
    );
    await expect(restartedOnAutomations.window.locator('.terminal-pane .perf-pane')).toHaveCount(0);
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

test('Logs replaces the previous conception’s sessions while selected', async () => {
  test.setTimeout(90_000);
  const secondConception = await mkdtemp(join(tmpdir(), 'condash-test-second-conception-'));
  const booted = await bootApp({
    prepare: async (firstConception) => {
      await mkdir(join(firstConception, '.condash', 'logs', '2026', '09', '29'), {
        recursive: true,
      });
      await writeFile(
        join(firstConception, '.condash', 'logs', '2026', '09', '29', '120000-t-first.txt'),
        'first conception\n',
      );
      await mkdir(join(secondConception, '.condash', 'logs', '2026', '09', '28'), {
        recursive: true,
      });
      await writeFile(join(secondConception, '.condash', 'settings.json'), '{}\n');
      await writeFile(
        join(secondConception, '.condash', 'logs', '2026', '09', '28', '120000-t-second.txt'),
        'second conception\n',
      );
      await mkdir(join(secondConception, 'projects', '2026-09', '2026-09-28-second'), {
        recursive: true,
      });
      await writeFile(
        join(secondConception, 'projects', '2026-09', '2026-09-28-second', 'README.md'),
        '# Second project\n\n**Status**: now\n**Kind**: project\n\n## Goal\n\nSecond tree.\n',
      );
    },
  });
  try {
    const { app, window } = booted;
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.logs-pane')).toBeVisible();
    await expect(window.locator('.logs-pane')).toContainText('Sep 29');
    await sendMenu(app, 'search');
    await expect(window.locator('.modal.search-modal')).toBeVisible();
    await window.locator('.search-modal-input').fill('first conception');
    await window.locator('.search-filter-btn').filter({ hasText: 'Logs' }).click();
    await expect(window.locator('.search-row').filter({ hasText: '2026-09-29' })).toBeVisible();
    await window.locator('.search-row').filter({ hasText: '2026-09-29' }).click();
    await expect(window.locator('.modal.logs-modal')).toBeVisible();
    await window.locator('.modal.logs-modal [aria-label="Close"]').click();
    await expect(window.locator('.modal.logs-modal')).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu-open-recent', path);
    }, secondConception);
    await expect(window.locator('.status-bar-path')).toHaveText(secondConception);
    await expect(window.locator('.surface-overlay')).toHaveCount(0);
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.logs-pane')).toContainText('Sep 28');
    await expect(window.locator('.logs-pane')).not.toContainText('Sep 29');
    await expect(window.locator('.modal.logs-modal')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(window.locator('.modal.logs-modal')).toHaveCount(0);
  } finally {
    await booted.cleanup();
    await rm(secondConception, { recursive: true, force: true });
  }
});
