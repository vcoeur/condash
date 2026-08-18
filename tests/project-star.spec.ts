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

test('the star gutter keeps the slug line aligned with its title', async () => {
  // The star claims a left gutter at the head of the title row, which pushes the
  // title text right. The slug line below is a sibling row, so it has to indent
  // by the same `--star-gutter` or it hangs out to the left of its own title —
  // exactly what the (conflict-free) merge with the slug-line feature produced.
  // Nothing else asserts that alignment, and no marker in the diff would show it.
  const booted = await bootApp({ prepare: prepareSibling });
  try {
    const card = booted.window.locator('article.row', { hasText: 'Alpha project' });
    const titleBox = await card.locator('.title-text').boundingBox();
    const slugBox = await card.locator('.slug').boundingBox();
    expect(titleBox, 'title text should be laid out').not.toBeNull();
    expect(slugBox, 'slug line should be laid out').not.toBeNull();
    expect(Math.abs(slugBox!.x - titleBox!.x)).toBeLessThanOrEqual(1);
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
