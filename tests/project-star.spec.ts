import { test, expect } from '@playwright/test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Projects-pane card star, end to end through the real UI.
 *
 * Four behaviours are worth an app-level spec rather than a unit test. The
 * star must (a) re-order its section immediately — the pane's sort reads the
 * store's signal, so a broken dependency chain shows up only in a live render;
 * (b) persist into the conception's `.condash/settings.json` and remove the key
 * again on unstar; (c) NOT open the card preview, since the whole card body
 * is clickable and the star only escapes that through the click-exclusion set;
 * and (d) disappear when the item reaches `done` — the rule is a renderer
 * effect over the project list feeding a main-process write, so nothing below
 * the IPC boundary can prove the two halves are wired to each other.
 *
 * The fixture ships `2026-04-26-sample` in `now`; `prepare` adds an older
 * sibling so the section has a stable two-card order (slugs sort descending,
 * so `sample` leads and `alpha` trails) for the star to visibly invert.
 */
const prepareSibling = async (conceptionDir: string): Promise<void> => {
  const dir = join(conceptionDir, 'projects', '2026-04', '2026-04-20-alpha');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'README.md'),
    `---\ndate: 2026-04-20\nkind: project\nstatus: now\n---\n\n# Alpha project\n\n## Goal\n\nOlder sibling fixture.\n`,
    'utf8',
  );
};

/** Same sibling, already closed — for the prune paths. */
const prepareDoneSibling = async (conceptionDir: string): Promise<void> => {
  const dir = join(conceptionDir, 'projects', '2026-04', '2026-04-20-alpha');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'README.md'),
    `---\ndate: 2026-04-20\nkind: project\nstatus: done\n---\n\n# Alpha project\n\n## Timeline\n\n- 2026-04-22 — Closed.\n`,
    'utf8',
  );
};

/** Slugs listed in the conception config, or `undefined` when the key is absent. */
async function starredOnDisk(conceptionDir: string): Promise<string[] | undefined> {
  const raw = await readFile(join(conceptionDir, '.condash', 'settings.json'), 'utf8');
  return (JSON.parse(raw) as { starredProjects?: string[] }).starredProjects;
}

test('starring a card floats it to the top of its section and persists', async () => {
  const booted = await bootApp({ prepare: prepareSibling });
  try {
    const win = booted.window;
    const nowTitles = win.locator('.group-block[data-status="now"] article.row .title-text');
    await expect(nowTitles).toHaveText(['Sample project', 'Alpha project']);

    // Star the trailing card.
    const alphaCard = win.locator('article.row', { hasText: 'Alpha project' });
    await alphaCard.locator('.star-toggle').click();

    // Re-order is immediate — the pane's sort depends on the store signal.
    await expect(nowTitles).toHaveText(['Alpha project', 'Sample project']);
    await expect(alphaCard.locator('.star-toggle')).toHaveClass(/starred/);
    await expect(alphaCard.locator('.star-toggle')).toHaveAttribute('aria-pressed', 'true');

    // …and lands in the conception config, not the README.
    await expect
      .poll(() => starredOnDisk(booted.conceptionDir), { timeout: 5000 })
      .toEqual(['2026-04-20-alpha']);
    const readme = await readFile(
      join(booted.conceptionDir, 'projects', '2026-04', '2026-04-20-alpha', 'README.md'),
      'utf8',
    );
    expect(readme).not.toContain('star');

    // Unstar: order restored and the key removed entirely.
    await alphaCard.locator('.star-toggle').click();
    await expect(nowTitles).toHaveText(['Sample project', 'Alpha project']);
    await expect(alphaCard.locator('.star-toggle')).not.toHaveClass(/starred/);
    await expect.poll(() => starredOnDisk(booted.conceptionDir), { timeout: 5000 }).toBeUndefined();
  } finally {
    await booted.cleanup();
  }
});

test('clicking the star does not open the card preview', async () => {
  const booted = await bootApp({ prepare: prepareSibling });
  try {
    const win = booted.window;
    const alphaCard = win.locator('article.row', { hasText: 'Alpha project' });
    await alphaCard.locator('.star-toggle').click();
    await expect(alphaCard.locator('.star-toggle')).toHaveClass(/starred/);

    // The whole card body opens the preview; the star must be excluded from it.
    await expect(win.locator('.modal.project-preview')).toHaveCount(0);

    // The card itself still opens — proving the exclusion is scoped to the star
    // and hasn't disabled the card-open path around it.
    await alphaCard.locator('.title-text').click();
    await win.waitForSelector('.modal.project-preview', { state: 'visible' });
    await expect(win.locator('.modal.project-preview .modal-title')).toHaveText('Alpha project');
  } finally {
    await booted.cleanup();
  }
});

test('the star opens the head row, with the dated slug beside it and the title below', async () => {
  // The card head is two rows: star | dated slug | actions on the first, kind
  // glyph + title on the second. Nothing else asserts that arrangement — a
  // stray flex rule can drop the slug to its own line or float the title up
  // beside the star, and no marker in the diff would show it — so measure the
  // laid-out boxes: star and slug share one line, and the title's first line
  // starts below it.
  const booted = await bootApp({ prepare: prepareSibling });
  try {
    const card = booted.window.locator('article.row', { hasText: 'Alpha project' });
    const starBox = await card.locator('.star-toggle').boundingBox();
    const slugBox = await card.locator('.slug').boundingBox();
    const glyphBox = await card.locator('.title .kind-glyph').boundingBox();
    const titleBox = await card.locator('.title-text').boundingBox();
    expect(starBox, 'star should be laid out').not.toBeNull();
    expect(slugBox, 'slug should be laid out').not.toBeNull();
    expect(glyphBox, 'kind glyph should be laid out').not.toBeNull();
    expect(titleBox, 'title text should be laid out').not.toBeNull();
    const centreY = (box: { y: number; height: number }) => box.y + box.height / 2;
    // One line: star and slug centred on the same y, left to right.
    expect(Math.abs(centreY(slugBox!) - centreY(starBox!))).toBeLessThanOrEqual(2);
    expect(slugBox!.x).toBeGreaterThan(starBox!.x + starBox!.width - 1);
    // The title row sits below the head row, glyph first, text after it (the
    // fixture title is one line, so the inline text span starts after the
    // glyph rather than wrapping back to the card's left edge).
    expect(glyphBox!.y).toBeGreaterThanOrEqual(slugBox!.y + slugBox!.height - 1);
    expect(titleBox!.x).toBeGreaterThan(glyphBox!.x + glyphBox!.width - 1);
  } finally {
    await booted.cleanup();
  }
});

test('a pre-seeded starred slug is honoured on first paint', async () => {
  // Cold-start path: the store loads the set from config on conception open, so
  // the very first render must already be starred-first.
  const booted = await bootApp({
    prepare: prepareSibling,
    extraConfig: { starredProjects: ['2026-04-20-alpha'] },
  });
  try {
    const win = booted.window;
    const nowTitles = win.locator('.group-block[data-status="now"] article.row .title-text');
    await expect(nowTitles).toHaveText(['Alpha project', 'Sample project']);
    await expect(
      win.locator('article.row', { hasText: 'Alpha project' }).locator('.star-toggle'),
    ).toHaveClass(/starred/);
  } finally {
    await booted.cleanup();
  }
});

test('closing a starred card drops its star and the config entry', async () => {
  // The whole loop in one gesture: the status change writes `status: done`, the
  // reconcile effect sees the patched list and prunes the slug out of
  // `starredProjects`, and the card stops offering a control that cannot hold.
  //
  // Ctrl+<n> on a focused card is the keyboard half of the status change — it
  // calls the same handler the lane drop does. Driven from the keyboard on
  // purpose: the pointer drag is covered by `status-drag.spec.ts`, and `done`
  // is the last of five stacked lanes, so its drop point needs the pane
  // scrolled and is worth nothing to this assertion.
  const booted = await bootApp({ prepare: prepareSibling });
  try {
    const win = booted.window;
    const alphaCard = win.locator('article.row', { hasText: 'Alpha project' });
    await alphaCard.locator('.star-toggle').click();
    await expect
      .poll(() => starredOnDisk(booted.conceptionDir), { timeout: 5000 })
      .toEqual(['2026-04-20-alpha']);

    // 5 = the index of `done` in KNOWN_STATUSES.
    await alphaCard.press('Control+5');

    await expect
      .poll(
        () =>
          readFile(
            join(booted.conceptionDir, 'projects', '2026-04', '2026-04-20-alpha', 'README.md'),
            'utf8',
          ),
        { timeout: 5000 },
      )
      .toContain('status: done');
    await expect.poll(() => starredOnDisk(booted.conceptionDir), { timeout: 5000 }).toBeUndefined();

    // Done renders collapsed by default — open it to read the card back.
    await win.locator('.projects-stack > .group-block[data-status="done"] > .group-header').click();
    await expect(alphaCard).toHaveAttribute('data-status-card', 'done');
    await expect(alphaCard.locator('.star-toggle')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('a star stranded on a done item clears itself on the next launch', async () => {
  // The self-heal path: stars pinned before this rule existed (or set by a
  // close that happened outside the app) are gone by first paint, config
  // included — the prune is a write, not a display-time filter.
  const booted = await bootApp({
    prepare: prepareDoneSibling,
    extraConfig: { starredProjects: ['2026-04-20-alpha'] },
  });
  try {
    const win = booted.window;
    await expect.poll(() => starredOnDisk(booted.conceptionDir), { timeout: 5000 }).toBeUndefined();

    const lane = win.locator('.projects-stack > .group-block[data-status="done"]');
    await lane.locator('> .group-header').click();
    const alphaCard = win.locator('article.row', { hasText: 'Alpha project' });
    await expect(alphaCard).toHaveCount(1);
    await expect(alphaCard.locator('.star-toggle')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('a close from outside the app drops the star while it is open', async () => {
  // `condash projects close` runs in its own process and never touches the
  // starred config; a hand-edited README does not even reach the app's code.
  // Both arrive here as a watcher patch, so the star has to fall out of the
  // list change itself rather than out of the pane's own status action.
  const booted = await bootApp({ prepare: prepareSibling });
  try {
    const win = booted.window;
    const alphaCard = win.locator('article.row', { hasText: 'Alpha project' });
    await alphaCard.locator('.star-toggle').click();
    await expect
      .poll(() => starredOnDisk(booted.conceptionDir), { timeout: 5000 })
      .toEqual(['2026-04-20-alpha']);

    // Close it behind the app's back — same bytes `condash projects close`
    // would leave on disk.
    await writeFile(
      join(booted.conceptionDir, 'projects', '2026-04', '2026-04-20-alpha', 'README.md'),
      `---\ndate: 2026-04-20\nkind: project\nstatus: done\n---\n\n# Alpha project\n\n## Timeline\n\n- 2026-04-22 — Closed.\n`,
      'utf8',
    );

    await expect
      .poll(() => starredOnDisk(booted.conceptionDir), { timeout: 10_000 })
      .toBeUndefined();
    // The starred filter must not keep listing it either — that was the way a
    // stale star stayed reachable with no control left to clear it.
    await win.locator('.projects-filter-starred').click();
    await expect(win.locator('article.row')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('a failed close leaves the star exactly where it was', async () => {
  // The star is dropped off the *optimistic* status patch, before the write is
  // confirmed — so a write that then fails would silently take the star with
  // it, on a path where the user is told nothing changed. And nothing gives it
  // back: a reopen deliberately never restores a star.
  const booted = await bootApp({ prepare: prepareSibling });
  const dir = join(booted.conceptionDir, 'projects', '2026-04', '2026-04-20-alpha');
  try {
    const win = booted.window;
    const alphaCard = win.locator('article.row', { hasText: 'Alpha project' });
    await alphaCard.locator('.star-toggle').click();
    await expect
      .poll(() => starredOnDisk(booted.conceptionDir), { timeout: 5000 })
      .toEqual(['2026-04-20-alpha']);

    // Make the README unwritable so the status write fails for real, rather
    // than stubbing the IPC and testing the stub.
    await chmod(dir, 0o555);
    await alphaCard.press('Control+5');
    await expect(win.locator('.toast')).toContainText('Status change failed');

    // Status rolled back, and the star with it — on disk and on the card.
    await expect(alphaCard).toHaveAttribute('data-status-card', 'now');
    await expect
      .poll(() => starredOnDisk(booted.conceptionDir), { timeout: 5000 })
      .toEqual(['2026-04-20-alpha']);
    await expect(alphaCard.locator('.star-toggle')).toHaveClass(/starred/);
  } finally {
    await chmod(dir, 0o755).catch(() => undefined);
    await booted.cleanup();
  }
});
