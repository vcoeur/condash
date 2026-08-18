import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

const goalScreenshotDir = resolve(__dirname, 'screenshots-out', 'project-goal');

/**
 * Card relations + whole-card click regression net (PR #452 / v4.95.0).
 *
 * A card renders two relation affordances when its project family resolves:
 * the "Part of" banner (`button.parent-banner`, on a card whose README has a
 * `parent:` header) and, on the parent's card, a subprojects fold
 * (`button.children-toggle`, collapsed by default) that opens to one row
 * (`button.child-row`) per spin-off child. Banner and rows are real buttons
 * that open the *referenced* project's preview — not the card they sit on. The same PR made the whole
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

test('the subprojects list is collapsed by default and its toggle does not open the card', async () => {
  const booted = await bootApp({ prepare: prepareFamily });
  try {
    const win = booted.window;

    // `is-parent` is derived from childrenOf(), so its presence also proves
    // the child's `parent:` slug resolved into the parent's subproject rows.
    const parentCard = win.locator('article.row.is-parent');
    await expect(parentCard).toBeVisible();

    // Collapsed by default: the fold header is there with the child count,
    // but no child row is mounted yet.
    const toggle = parentCard.locator('button.children-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle.locator('.children-toggle-count')).toHaveText('1');
    await expect(parentCard.locator('button.child-row')).toHaveCount(0);

    // The toggle is in the card's click-exclusion set: expanding must not
    // also open the parent's own preview.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(parentCard.locator('button.child-row')).toHaveCount(1);
    await win.waitForTimeout(300);
    await expect(win.locator('.modal.project-preview')).toHaveCount(0);

    // And it folds back.
    await toggle.click();
    await expect(parentCard.locator('button.child-row')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('clicking a subproject row on the parent card opens the child preview', async () => {
  const booted = await bootApp({ prepare: prepareFamily });
  try {
    const win = booted.window;

    const parentCard = win.locator('article.row.is-parent');
    await expect(parentCard).toBeVisible();
    // Rows are folded away by default — expand first, then click a row.
    await parentCard.locator('button.children-toggle').click();
    await parentCard.locator('button.child-row').click();

    await win.waitForSelector('.modal.project-preview', { state: 'visible' });
    await expect(win.locator('.modal.project-preview .modal-title')).toHaveText('Child impl');
  } finally {
    await booted.cleanup();
  }
});

test('only family cards carry a family colour class; every known kind shows its glyph', async () => {
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      await prepareFamily(conceptionDir);
      // A `parent:` that resolves to nothing: dashed frame, raw-slug banner,
      // but no colour — there is no second card for a hue to tie it to.
      const orphanDir = join(conceptionDir, 'projects', '2026-04', '2026-04-22-orphan-impl');
      await mkdir(orphanDir, { recursive: true });
      await writeFile(
        join(orphanDir, 'README.md'),
        `---\ndate: 2026-04-22\nkind: project\nstatus: now\nparent: 2026-01-01-never-existed\n---\n\n# Orphan impl\n\n## Goal\n\nDangling-parent fixture.\n`,
        'utf8',
      );
      // A mid-tree node: its own parent dangles, but it has a child. It must
      // hash its OWN slug (not the dead one) so it and its child share a hue.
      const midDir = join(conceptionDir, 'projects', '2026-04', '2026-04-23-mid-plan');
      await mkdir(midDir, { recursive: true });
      await writeFile(
        join(midDir, 'README.md'),
        `---\ndate: 2026-04-23\nkind: project\nstatus: now\nparent: 2026-01-01-never-existed\n---\n\n# Mid plan\n\n## Goal\n\nMid-tree fixture.\n`,
        'utf8',
      );
      const midChildDir = join(conceptionDir, 'projects', '2026-04', '2026-04-24-mid-child');
      await mkdir(midChildDir, { recursive: true });
      await writeFile(
        join(midChildDir, 'README.md'),
        `---\ndate: 2026-04-24\nkind: project\nstatus: now\nparent: 2026-04-23-mid-plan\n---\n\n# Mid child\n\n## Goal\n\nMid-tree child fixture.\n`,
        'utf8',
      );
    },
  });
  try {
    const win = booted.window;

    // The parent and its child share one `proj-family-<n>` slot; the
    // standalone sample project has none — the neutral frame is the default.
    const parentCard = win.locator('article.row.is-parent', { hasText: 'Parent plan' });
    const childCard = win.locator('article.row.is-subproject', { hasText: 'Child impl' });
    const orphan = win.locator('article.row.is-subproject', { hasText: 'Orphan impl' });
    const midPlan = win.locator('article.row.is-parent', { hasText: 'Mid plan' });
    const midChild = win.locator('article.row.is-subproject', { hasText: 'Mid child' });
    const standalone = win.locator('article.row', { hasText: 'Sample project' });
    await expect(parentCard).toBeVisible();
    await expect(orphan).toBeVisible();
    await expect(midChild).toBeVisible();
    const familyClass = async (card: typeof parentCard): Promise<string | undefined> => {
      const classes = (await card.getAttribute('class')) ?? '';
      return classes.split(/\s+/).find((c) => c.startsWith('proj-family-'));
    };
    const parentSlot = await familyClass(parentCard);
    expect(parentSlot).toMatch(/^proj-family-\d+$/);
    expect(await familyClass(childCard)).toBe(parentSlot);
    expect(await familyClass(standalone)).toBeUndefined();
    expect(await familyClass(orphan)).toBeUndefined();
    await expect(orphan).not.toHaveClass(/in-family/);
    await expect(childCard).toHaveClass(/in-family/);
    // Mid-tree: coloured (it has a child), and the SAME slot as that child —
    // hashing the dangling parent slug instead would give it a hue of its own.
    const midSlot = await familyClass(midPlan);
    expect(midSlot).toMatch(/^proj-family-\d+$/);
    expect(await familyClass(midChild)).toBe(midSlot);

    // A plain project card shows the kind glyph too (it used to be
    // incident/document only).
    await expect(standalone.locator('.title .kind-glyph[data-kind="project"]')).toBeVisible();
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

test('project preview renders every Goal paragraph immediately above Activity', async () => {
  const firstParagraph = `Opening marker ${'complete source text '.repeat(20)}first paragraph marker.`;
  const finalParagraph = 'Final paragraph marker.';
  const goal = `${firstParagraph}\n\n${finalParagraph}`;
  await mkdir(goalScreenshotDir, { recursive: true });

  for (const theme of ['dark', 'light']) {
    const booted = await bootApp({
      globalConfig: { theme },
      prepare: async (conceptionDir) => {
        const projectDir = join(conceptionDir, 'projects', '2026-08', '2026-08-12-long-goal');
        await mkdir(projectDir, { recursive: true });
        await writeFile(
          join(projectDir, 'README.md'),
          `---\ndate: 2026-08-12\nkind: project\nstatus: now\n---\n\n# Long goal\n\n## Goal\n\n${firstParagraph}\n\n\n${finalParagraph}\n\n## Timeline\n\n- 2026-08-12 — Later section marker.\n`,
          'utf8',
        );
      },
    });
    try {
      const win = booted.window;
      await win.locator('article.row', { hasText: 'Long goal' }).click();

      const widgets = win.locator('.modal.project-preview .revamped-main > .widget');
      const goalWidget = widgets.filter({
        has: win.locator('.widget-title', { hasText: /^Goal$/ }),
      });
      const goalProse = goalWidget.locator('p');
      const activityWidget = widgets.filter({
        has: win.locator('.widget-title', { hasText: /^Activity$/ }),
      });
      expect(goal.length).toBeGreaterThan(300);
      await expect(goalProse).toHaveText(goal);
      expect(await goalProse.evaluate((element) => element.textContent)).toBe(goal);
      expect(await goalProse.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe(
        'pre-line',
      );
      await expect(goalWidget).not.toContainText('Later section marker');
      expect(
        await goalWidget.evaluate(
          (goalElement, activityElement) => {
            return goalElement.nextElementSibling === activityElement;
          },
          await activityWidget.elementHandle(),
        ),
      ).toBe(true);
      await win.screenshot({ path: join(goalScreenshotDir, `goal-widget-${theme}.png`) });
    } finally {
      await booted.cleanup();
    }
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
