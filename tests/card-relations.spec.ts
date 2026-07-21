import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Card relations + whole-card click regression net (PR #452 / v4.95.0).
 *
 * A card renders two relation affordances when its project family resolves:
 * the "Part of" banner (`button.parent-banner`, on a card whose README has a
 * `parent:` header) and one subproject row (`button.child-row`) per spin-off
 * child on the parent's card. Both are real buttons that open the *referenced*
 * project's preview — not the card they sit on. The same PR made the whole
 * card body clickable (open preview), with an exclusion set for interactive
 * children and a 4px pointer threshold so a status drag never doubles as an
 * open. These specs pin all four behaviours end-to-end through the UI.
 *
 * The parent lookup keys on the FULL dated dir name (`Project.slug` =
 * `basename(dirname(path))`, matched verbatim against the child's `parent:`
 * frontmatter), so the fixture child declares `parent: 2026-04-20-parent-plan`.
 */

// Write a parent/child project pair beside the default sample project. Runs
// inside bootApp's `prepare` so the initial tree read sees both files without
// depending on the chokidar watcher (racy under xvfb).
const prepareFamily = async (conceptionDir: string): Promise<void> => {
  const month = join(conceptionDir, 'projects', '2026-04');
  await mkdir(join(month, '2026-04-20-parent-plan'), { recursive: true });
  await writeFile(
    join(month, '2026-04-20-parent-plan', 'README.md'),
    `---\ndate: 2026-04-20\nkind: project\nstatus: now\n---\n\n# Parent plan\n\n## Goal\n\nParent fixture project.\n\n## Steps\n\n- [ ] Plan the work\n`,
    'utf8',
  );
  await mkdir(join(month, '2026-04-21-child-impl'), { recursive: true });
  await writeFile(
    join(month, '2026-04-21-child-impl', 'README.md'),
    `---\ndate: 2026-04-21\nkind: project\nstatus: now\nparent: 2026-04-20-parent-plan\n---\n\n# Child impl\n\n## Goal\n\nChild fixture project.\n`,
    'utf8',
  );
};

test('clicking the parent banner on a child card opens the parent preview', async () => {
  const booted = await bootApp({ prepare: prepareFamily });
  try {
    const win = booted.window;

    // The dashed-frame class only lands when the README's `parent:` header
    // parsed; the clickable banner additionally needs the slug to resolve
    // against the project list (a dangling slug renders a non-button <div>).
    const childCard = win.locator('article.row.is-subproject');
    await expect(childCard).toBeVisible();
    await childCard.locator('button.parent-banner').click();

    // The banner must open the PARENT's preview, not the child card it sits on.
    await win.waitForSelector('.modal.project-preview', { state: 'visible' });
    await expect(win.locator('.modal.project-preview .modal-title')).toHaveText('Parent plan');
  } finally {
    await booted.cleanup();
  }
});

test('clicking a subproject row on the parent card opens the child preview', async () => {
  const booted = await bootApp({ prepare: prepareFamily });
  try {
    const win = booted.window;

    // `is-parent` is derived from childrenOf(), so its presence also proves
    // the child's `parent:` slug resolved into the parent's subproject rows.
    const parentCard = win.locator('article.row.is-parent');
    await expect(parentCard).toBeVisible();
    await parentCard.locator('button.child-row').click();

    await win.waitForSelector('.modal.project-preview', { state: 'visible' });
    await expect(win.locator('.modal.project-preview .modal-title')).toHaveText('Child impl');
  } finally {
    await booted.cleanup();
  }
});

test('clicking the card body (not the title) opens that project preview', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    await win.waitForSelector('article.row', { state: 'visible', timeout: 5000 });

    // The date span sits in the meta row: not the title, not in the click
    // exclusion set (.row-action, .pr-badge, .title-actions, banner buttons)
    // — a plain body click that must bubble up to the whole-card open.
    await win.click('article.row .meta-icon.date');

    await win.waitForSelector('.modal.project-preview', { state: 'visible' });
    await expect(win.locator('.modal.project-preview .modal-title')).toHaveText('Sample project');
  } finally {
    await booted.cleanup();
  }
});

test('switching projects via the preview banner drops a half-typed step draft', async () => {
  // Both projects are stepless so the add-step input is exposed on each —
  // the exact shape of the pre-#453 leak: text typed on the child survived
  // the banner switch and Enter would append it to the PARENT's README.
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      const month = join(conceptionDir, 'projects', '2026-04');
      await mkdir(join(month, '2026-04-20-parent-plan'), { recursive: true });
      await writeFile(
        join(month, '2026-04-20-parent-plan', 'README.md'),
        `---\ndate: 2026-04-20\nkind: project\nstatus: now\n---\n\n# Parent plan\n\n## Goal\n\nStepless parent fixture.\n`,
        'utf8',
      );
      await mkdir(join(month, '2026-04-21-child-impl'), { recursive: true });
      await writeFile(
        join(month, '2026-04-21-child-impl', 'README.md'),
        `---\ndate: 2026-04-21\nkind: project\nstatus: now\nparent: 2026-04-20-parent-plan\n---\n\n# Child impl\n\n## Goal\n\nStepless child fixture.\n`,
        'utf8',
      );
    },
  });
  try {
    const win = booted.window;

    await win.click('article.row.is-subproject .title');
    await win.waitForSelector('.modal.project-preview', { state: 'visible' });
    await expect(win.locator('.modal.project-preview .modal-title')).toHaveText('Child impl');

    // Zero steps → the add-step input is already exposed; type without committing.
    const addInput = win.locator('.modal.project-preview .add-step-form input');
    await addInput.fill('half-typed step');

    // Swap the previewed project in place via the modal's own banner button.
    await win.click('.modal.project-preview button.parent-banner-name');
    await expect(win.locator('.modal.project-preview .modal-title')).toHaveText('Parent plan');

    // The reset effect must have dropped the draft — before #453 the child's
    // text was still sitting here, one Enter away from the wrong README.
    await expect(addInput).toHaveValue('');
  } finally {
    await booted.cleanup();
  }
});

test('a pointer gesture past the drag threshold does not open the preview', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    const card = win.locator('article.row').first();
    await expect(card).toHaveAttribute('data-status-card', 'now');

    // Press → move past the 4px DRAG_THRESHOLD_PX → release inside the same
    // lane. The gesture becomes a drag, so the click the browser synthesises
    // on release must be swallowed instead of opening the preview.
    const box = await card.boundingBox();
    if (!box) throw new Error('card has no bounding box');
    const startX = box.x + box.width / 2;
    const startY = box.y + 16;
    await win.mouse.move(startX, startY);
    await win.mouse.down();
    await win.mouse.move(startX, startY + 10, { steps: 3 });
    await win.mouse.up();

    // Modal-open is synchronous with the click, so a short settle is enough
    // to prove no preview appeared; the release over the card's own lane must
    // also leave the status untouched.
    await win.waitForTimeout(300);
    await expect(win.locator('.modal.project-preview')).toHaveCount(0);
    await expect(card).toHaveAttribute('data-status-card', 'now');
  } finally {
    await booted.cleanup();
  }
});
