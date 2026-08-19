import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * The Projects-pane search + filter bar, end to end through the real UI.
 *
 * Three predicates — README search (a main-process query over the search
 * index, answered as matched paths), starred-only, and an apps multiselect —
 * AND together and narrow the cards in place. Under an active filter a section
 * that filtered down to nothing is hidden, and one that still has matches is
 * forced open even when collapsed by default (`backlog`, `done`), so a match
 * is never behind a fold. Worth an app-level spec because every one of those
 * crosses a boundary a unit test can't see: the IPC round-trip and its debounce,
 * the star store's signal, the force-open of collapsed sections, and the
 * portal'd apps menu.
 *
 * Fixture: the default `2026-04-26-sample` (now, no apps) plus four items —
 * a `now` item on `#nodum` whose README says "orchid", a `later` item on
 * `#condash` that says "orchid", a `backlog` item on `#condash` (no orchid),
 * and a `done` item on `#condash` + `#nodum` that says "orchid".
 */
const prepare = async (conceptionDir: string): Promise<void> => {
  const seed = async (slug: string, body: string): Promise<void> => {
    const dir = join(conceptionDir, 'projects', slug.slice(0, 7), slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'README.md'), body, 'utf8');
  };
  await seed(
    '2026-04-20-nodum-now',
    `---\ndate: 2026-04-20\nkind: incident\nstatus: now\napps:\n  - nodum\n---\n\n# Nodum now\n\n## Goal\n\nAn orchid in the goal.\n`,
  );
  await seed(
    '2026-04-21-condash-later',
    `---\ndate: 2026-04-21\nkind: project\nstatus: later\napps:\n  - condash\n---\n\n# Condash later\n\n## Goal\n\nAnother orchid.\n`,
  );
  await seed(
    '2026-04-22-condash-backlog',
    `---\ndate: 2026-04-22\nkind: project\nstatus: backlog\napps:\n  - condash\n---\n\n# Condash backlog\n\n## Goal\n\nNo flower here.\n`,
  );
  await seed(
    '2026-04-23-both-done',
    `---\ndate: 2026-04-23\nkind: project\nstatus: done\napps:\n  - condash\n  - nodum\n---\n\n# Both done\n\n## Goal\n\nA closed orchid.\n\n## Timeline\n\n- 2026-04-23 — Closed.\n`,
  );
};

/** Titles of every visible card, in DOM order. */
const visibleTitles = (win: import('@playwright/test').Page) =>
  win.locator('article.row .title-text');

test('the README search narrows the cards, forces matching sections open and hides empty ones', async () => {
  const booted = await bootApp({ prepare });
  try {
    const win = booted.window;
    // Idle: five cards exist, but backlog and done start collapsed, so only the
    // now + later cards are laid out; every section header is present.
    await expect(visibleTitles(win)).toHaveText(['Sample project', 'Nodum now', 'Condash later']);
    await expect(win.locator('.group-block[data-status="review"]')).toBeVisible();

    await win.fill('.projects-filter-input', 'orchid');
    // The done match is inside a collapsed-by-default section — forced open by
    // the active filter, its card becomes visible; the empty review/backlog
    // sections disappear.
    await expect(visibleTitles(win)).toHaveText(['Nodum now', 'Condash later', 'Both done']);
    await expect(win.locator('.group-block[data-status="review"]')).toHaveCount(0);
    await expect(win.locator('.projects-stack > .group-block[data-status="backlog"]')).toHaveCount(
      0,
    );
    await expect(win.locator('.projects-filter-count')).toHaveText('3 of 5');

    // A query nothing matches: empty state, no sections at all.
    await win.fill('.projects-filter-input', 'zzznomatch');
    await expect(win.locator('.projects-filter-empty')).toBeVisible();
    await expect(win.locator('article.row')).toHaveCount(0);
    await expect(win.locator('.projects-filter-count')).toHaveText('0 of 5');

    // Esc in the field clears the query only; everything comes back and the
    // default folds are restored (done collapsed again).
    await win.press('.projects-filter-input', 'Escape');
    await expect(win.locator('.projects-filter-input')).toHaveValue('');
    await expect(visibleTitles(win)).toHaveText(['Sample project', 'Nodum now', 'Condash later']);
    await expect(win.locator('.projects-filter-count')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('the starred toggle keeps only starred cards and combines with the search', async () => {
  const booted = await bootApp({
    prepare,
    extraConfig: { starredProjects: ['2026-04-26-sample', '2026-04-23-both-done'] },
  });
  try {
    const win = booted.window;
    const starred = win.locator('.projects-filter-starred');
    await starred.click();
    await expect(starred).toHaveAttribute('aria-pressed', 'true');
    // Both starred cards, the done one pulled out of its fold.
    await expect(visibleTitles(win)).toHaveText(['Sample project', 'Both done']);
    await expect(win.locator('.projects-filter-count')).toHaveText('2 of 5');

    // AND with the search: only the starred item whose README says orchid.
    await win.fill('.projects-filter-input', 'orchid');
    await expect(visibleTitles(win)).toHaveText(['Both done']);

    // Clear filters resets every control at once.
    await win.click('.projects-filter-reset');
    await expect(starred).toHaveAttribute('aria-pressed', 'false');
    await expect(win.locator('.projects-filter-input')).toHaveValue('');
    await expect(visibleTitles(win)).toHaveText(['Sample project', 'Nodum now', 'Condash later']);
  } finally {
    await booted.cleanup();
  }
});

test('the apps multiselect is any-of, keeps its menu open across toggles and reports its count', async () => {
  const booted = await bootApp({ prepare });
  try {
    const win = booted.window;
    await win.click('.projects-filter-apps');
    const menu = win.locator('.projects-filter-apps-menu');
    await expect(menu).toBeVisible();
    // Options are the handles the list mentions, sorted, one each.
    await expect(menu.locator('.projects-filter-apps-option')).toHaveText(['#condash', '#nodum']);

    await menu
      .locator('.projects-filter-apps-option', { hasText: '#nodum' })
      .locator('input')
      .check();
    // The menu stays open (a multiselect that closes per click is unusable),
    // the trigger shows the count, and the cards narrow to nodum items —
    // including the done one, forced out of its fold.
    await expect(menu).toBeVisible();
    await expect(win.locator('.projects-filter-apps .projects-filter-chip-count')).toHaveText('1');
    await expect(visibleTitles(win)).toHaveText(['Nodum now', 'Both done']);

    // Any-of: adding condash widens the result, it does not intersect.
    await menu
      .locator('.projects-filter-apps-option', { hasText: '#condash' })
      .locator('input')
      .check();
    await expect(win.locator('.projects-filter-apps .projects-filter-chip-count')).toHaveText('2');
    await expect(visibleTitles(win)).toHaveText([
      'Nodum now',
      'Condash later',
      'Condash backlog',
      'Both done',
    ]);
    await expect(win.locator('.projects-filter-count')).toHaveText('4 of 5');

    // Clear apps from inside the menu; Escape closes it.
    await menu.locator('.projects-filter-apps-clear').click();
    await expect(win.locator('.projects-filter-apps .projects-filter-chip-count')).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(visibleTitles(win)).toHaveText(['Sample project', 'Nodum now', 'Condash later']);
  } finally {
    await booted.cleanup();
  }
});
