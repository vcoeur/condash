import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Projects-pane card star, end to end through the real UI.
 *
 * Three behaviours are worth an app-level spec rather than a unit test. The
 * star must (a) re-order its section immediately — the pane's sort reads the
 * store's signal, so a broken dependency chain shows up only in a live render;
 * (b) persist into the conception's `.condash/settings.json` and remove the key
 * again on unstar; and (c) NOT open the card preview, since the whole card body
 * is clickable and the star only escapes that through the click-exclusion set.
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

test('the star opens the head row, with the slug and date beside it and the title below', async () => {
  // The card head is two rows: star | slug · date | actions on the first, kind
  // badge + title on the second. Nothing else asserts that arrangement — a
  // stray flex rule can drop the date to its own line or float the title up
  // beside the star, and no marker in the diff would show it — so measure the
  // laid-out boxes: star, slug and date share one line, and the title's first
  // line starts below it.
  const booted = await bootApp({ prepare: prepareSibling });
  try {
    const card = booted.window.locator('article.row', { hasText: 'Alpha project' });
    const starBox = await card.locator('.star-toggle').boundingBox();
    const slugBox = await card.locator('.slug').boundingBox();
    const dateBox = await card.locator('.date').boundingBox();
    const badgeBox = await card.locator('.kind-badge').boundingBox();
    const titleBox = await card.locator('.title-text').boundingBox();
    expect(starBox, 'star should be laid out').not.toBeNull();
    expect(slugBox, 'slug should be laid out').not.toBeNull();
    expect(dateBox, 'date should be laid out').not.toBeNull();
    expect(badgeBox, 'kind badge should be laid out').not.toBeNull();
    expect(titleBox, 'title text should be laid out').not.toBeNull();
    const centreY = (box: { y: number; height: number }) => box.y + box.height / 2;
    // One line: star, slug and date centred on the same y, left to right.
    expect(Math.abs(centreY(slugBox!) - centreY(starBox!))).toBeLessThanOrEqual(2);
    expect(Math.abs(centreY(dateBox!) - centreY(slugBox!))).toBeLessThanOrEqual(2);
    expect(slugBox!.x).toBeGreaterThan(starBox!.x + starBox!.width - 1);
    expect(dateBox!.x).toBeGreaterThan(slugBox!.x + slugBox!.width - 1);
    // The title row sits below the head row, badge first, text after it (the
    // fixture title is one line, so the inline text span starts after the
    // badge rather than wrapping back to the card's left edge).
    expect(badgeBox!.y).toBeGreaterThanOrEqual(slugBox!.y + slugBox!.height - 1);
    expect(titleBox!.x).toBeGreaterThan(badgeBox!.x + badgeBox!.width - 1);
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
