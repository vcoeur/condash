import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * The Projects-pane search + filter bar, end to end through the real UI.
 *
 * Three predicates — README search (a main-process query over the search
 * index, answered as matched paths), starred-only, and an apps multiselect —
 * AND together and narrow the cards in place. Under an active filter every
 * section stays (an empty one as its empty header, which is also a drop lane),
 * and one that has matches is forced open even when collapsed by default
 * (`backlog`, `done`), so a match is never behind a fold — and its header stops
 * being a toggle, so a click cannot persist a fold the user cannot see. Worth an
 * app-level spec because every one of those crosses a boundary a unit test
 * can't see: the IPC round-trip and its debounce, the star store's signal, the
 * force-open of collapsed sections, and the portal'd apps menu.
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

test('the README search narrows the cards and forces matching sections open, keeping empty ones as lanes', async () => {
  const booted = await bootApp({ prepare });
  try {
    const win = booted.window;
    // Idle: five cards exist, but backlog and done start collapsed, so only the
    // now + later cards are laid out; every section header is present.
    await expect(visibleTitles(win)).toHaveText(['Sample project', 'Nodum now', 'Condash later']);
    const review = win.locator('.projects-stack > .group-block[data-status="review"]');
    const done = win.locator('.projects-stack > .group-block[data-status="done"]');
    await expect(review).toBeVisible();
    await expect(done).toHaveClass(/collapsed/);

    // One character is below the search floor: nothing filters, no count.
    await win.fill('.projects-filter-input', 'o');
    await expect(win.locator('.projects-filter-count')).toHaveCount(0);
    await expect(visibleTitles(win)).toHaveText(['Sample project', 'Nodum now', 'Condash later']);

    await win.fill('.projects-filter-input', 'orchid');
    // The done match is inside a collapsed-by-default section — forced open by
    // the active filter, its card becomes visible. Empty sections stay as their
    // empty headers (they are the drop lanes a card drag needs).
    await expect(visibleTitles(win)).toHaveText(['Nodum now', 'Condash later', 'Both done']);
    await expect(review).toBeVisible();
    await expect(review).toHaveAttribute('data-empty', 'true');
    await expect(win.locator('.projects-filter-count')).toHaveText('3 of 5');

    // The forced-open done header is not a toggle for the duration: clicking it
    // neither closes the section nor persists a collapsed state.
    await expect(done.locator('> .group-header')).toHaveAttribute(
      'title',
      'Held open by the filter',
    );
    await done.locator('> .group-header').click();
    await expect(visibleTitles(win)).toHaveText(['Nodum now', 'Condash later', 'Both done']);
    expect(
      await win.evaluate(() => window.localStorage.getItem('condash:projects:section-collapse')),
    ).toBeNull();

    // A query nothing matches: empty state, sections still present.
    await win.fill('.projects-filter-input', 'zzznomatch');
    await expect(win.locator('.projects-filter-empty')).toBeVisible();
    await expect(win.locator('article.row')).toHaveCount(0);
    await expect(win.locator('.projects-filter-count')).toHaveText('0 of 5');
    await expect(review).toBeVisible();

    // Esc in the field clears the query only; everything comes back and the
    // default folds are restored (done collapsed again, exactly as before).
    await win.press('.projects-filter-input', 'Escape');
    await expect(win.locator('.projects-filter-input')).toHaveValue('');
    await expect(visibleTitles(win)).toHaveText(['Sample project', 'Nodum now', 'Condash later']);
    await expect(win.locator('.projects-filter-count')).toHaveCount(0);
    await expect(done).toHaveClass(/collapsed/);
  } finally {
    await booted.cleanup();
  }
});

test('the starred toggle keeps only starred cards and combines with the search', async () => {
  // The `backlog` item stands in for the collapsed-section case: a done item
  // cannot be starred (the set is pruned of done slugs on every read), so
  // `backlog` is the only default-collapsed section a star can reach.
  const booted = await bootApp({
    prepare,
    extraConfig: { starredProjects: ['2026-04-26-sample', '2026-04-22-condash-backlog'] },
  });
  try {
    const win = booted.window;
    const starred = win.locator('.projects-filter-starred');
    await starred.click();
    await expect(starred).toHaveAttribute('aria-pressed', 'true');
    // Both starred cards, the backlog one pulled out of its fold.
    await expect(visibleTitles(win)).toHaveText(['Sample project', 'Condash backlog']);
    await expect(win.locator('.projects-filter-count')).toHaveText('2 of 5');

    // AND with the search: only the starred item whose README says flower.
    await win.fill('.projects-filter-input', 'flower');
    await expect(visibleTitles(win)).toHaveText(['Condash backlog']);

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
    // A real portal: out of the pane's subtree, fixed, and actually painted
    // (a probe just inside its corner hits it) — `toBeVisible` alone would
    // pass for a menu clipped by a `contain: layout paint` ancestor.
    const paint = await menu.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const probe = document.elementFromPoint(rect.left + 10, rect.top + 4);
      return {
        escaped: !el.closest('.projects-pane'),
        position: getComputedStyle(el).position,
        hit: el === probe || el.contains(probe as Node),
        background: getComputedStyle(el).backgroundColor,
      };
    });
    expect(paint.escaped).toBe(true);
    expect(paint.position).toBe('fixed');
    expect(paint.hit).toBe(true);
    expect(paint.background).not.toBe('rgba(0, 0, 0, 0)');
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

test('a section that (re)mounts while held open is a working toggle again once the filter clears', async () => {
  // Solid binds an event handler expression once at mount. A header whose
  // `onClick` was `forceOpen ? undefined : toggle` therefore stayed inert for
  // its whole life if its GroupBlock mounted while the filter was active — and
  // a section whose membership the filter did not change is *reused* (not
  // remounted) when the filter clears, so the dead handler survived the
  // clear. Reproduce that exact shape: apps = #condash (every `later` item is
  // on #condash, so `later`'s membership is unchanged by the filter), then a
  // status flip on disk moves the backlog item into `later` — new membership,
  // the `later` Group is rebuilt and its block remounts under forceOpen — then
  // Clear filters reuses it, and its header must still collapse on click.
  // (A README *content* patch is not enough: the store reconciles in place,
  // so the Project object — and the Group — keep their identity.)
  const booted = await bootApp({ prepare });
  try {
    const win = booted.window;
    const later = win.locator('.projects-stack > .group-block[data-status="later"]');
    await win.click('.projects-filter-apps');
    await win
      .locator('.projects-filter-apps-menu .projects-filter-apps-option', { hasText: '#condash' })
      .locator('input')
      .check();
    await win.keyboard.press('Escape');
    await expect(later.locator('article.row .title-text')).toHaveText(['Condash later']);
    await expect(later.locator('> .group-header')).toHaveAttribute(
      'title',
      'Held open by the filter',
    );

    // Move the backlog item into `later` on disk: `later`'s membership changes,
    // its Group is rebuilt and the block remounts while forced open.
    await writeFile(
      join(booted.conceptionDir, 'projects', '2026-04', '2026-04-22-condash-backlog', 'README.md'),
      `---\ndate: 2026-04-22\nkind: project\nstatus: later\napps:\n  - condash\n---\n\n# Condash backlog\n\n## Goal\n\nNo flower here.\n`,
      'utf8',
    );
    await expect(later.locator('article.row .title-text')).toHaveText(
      ['Condash backlog', 'Condash later'],
      { timeout: 10_000 },
    );

    // Clear filters: `later`'s membership is what it was, so the block is reused.
    await win.click('.projects-filter-reset');
    await expect(later.locator('> .group-header')).toHaveAttribute('title', 'Collapse section');
    await later.locator('> .group-header').click();
    await expect(later).toHaveClass(/collapsed/);
    await expect(later.locator('article.row')).toHaveCount(0);
    // …and it reopens.
    await later.locator('> .group-header').click();
    await expect(later).not.toHaveClass(/collapsed/);
    await expect(later.locator('article.row')).toHaveCount(2);
  } finally {
    await booted.cleanup();
  }
});
