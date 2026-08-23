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

    // The dashed-left-edge class only lands when the README's `parent:` header
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
      // A `parent:` that resolves to nothing: dashed left edge, raw-slug banner,
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
      // Third level: the grandchild's parent resolves (mid-child), which
      // itself resolves (mid-plan). The whole chain must hash the ROOT —
      // one hop up would give the grandchild mid-child's own slot.
      const grandDir = join(conceptionDir, 'projects', '2026-04', '2026-04-25-mid-grandchild');
      await mkdir(grandDir, { recursive: true });
      await writeFile(
        join(grandDir, 'README.md'),
        `---\ndate: 2026-04-25\nkind: project\nstatus: now\nparent: 2026-04-24-mid-child\n---\n\n# Mid grandchild\n\n## Goal\n\nThird-level fixture.\n`,
        'utf8',
      );
      // A second kind, so "every known kind" is more than the default one:
      // this is the card the glyph assertion below has to be distinguishable
      // from. Standalone (no `parent:`), so it stays out of the family
      // colouring asserted above.
      const incidentDir = join(conceptionDir, 'projects', '2026-04', '2026-04-21-pager-fired');
      await mkdir(incidentDir, { recursive: true });
      await writeFile(
        join(incidentDir, 'README.md'),
        `---\ndate: 2026-04-21\nkind: incident\nstatus: now\nenvironment: PROD\nseverity: high — fixture\n---\n\n# Pager fired\n\n## Goal\n\nSecond-kind fixture.\n`,
        'utf8',
      );
    },
  });
  try {
    const win = booted.window;
    // Match on the card's own title, not any text on the card — a child's
    // "Part of" banner carries its parent's title too.
    const cardTitled = (title: string) =>
      win.locator('article.row', { has: win.locator('.title-text', { hasText: title }) });

    // The parent and its child share one `proj-family-<n>` slot; the
    // standalone sample project has none — the neutral frame is the default.
    const parentCard = cardTitled('Parent plan');
    const childCard = cardTitled('Child impl');
    const orphan = cardTitled('Orphan impl');
    const midPlan = cardTitled('Mid plan');
    const midChild = cardTitled('Mid child');
    const midGrandchild = cardTitled('Mid grandchild');
    const standalone = cardTitled('Sample project');
    const incident = cardTitled('Pager fired');
    await expect(parentCard).toHaveClass(/is-parent/);
    await expect(childCard).toHaveClass(/is-subproject/);
    await expect(orphan).toHaveClass(/is-subproject/);
    await expect(midGrandchild).toBeVisible();
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
    // Mid-tree chain: mid-plan (parent dangles, has a child) is the root and
    // is coloured; mid-child and mid-grandchild wear the SAME slot. djb2 mod 16
    // of the fixture slugs: never-existed → 5, mid-plan → 15, mid-child → 11,
    // mid-grandchild → 8 — so hashing the dangling parent (5) or one hop up
    // (grandchild → 11) each break a different assertion below. Keep the slugs
    // if you edit this test, or recompute the slots.
    const midSlot = await familyClass(midPlan);
    expect(midSlot).toBe('proj-family-15');
    expect(await familyClass(midChild)).toBe(midSlot);
    expect(await familyClass(midGrandchild)).toBe(midSlot);

    // A plain project card wears the kind glyph too (it used to be
    // incident/document only); the kind is carried by the icon and its
    // tooltip, not by a spelled-out label. Queried through the accessibility
    // tree on purpose: the card's own aria-label is `<title>, <status>` and
    // never names the kind, so this glyph is the only thing that tells a
    // screen-reader user an incident card from a project card — and its
    // aria-label only counts because of the role. A bare span computes as
    // `role=generic`, where the attribute is prohibited and may be dropped.
    // Both kinds are asserted because that distinction is the whole point;
    // one of them alone would pass on a component that hard-coded a label.
    for (const [card, kind, label] of [
      [standalone, 'project', 'Project'],
      [incident, 'incident', 'Incident'],
    ] as const) {
      const glyph = card.getByRole('img', { name: label });
      await expect(glyph).toBeVisible();
      await expect(glyph).toHaveClass(/kind-glyph/);
      await expect(glyph).toHaveAttribute('title', label);
      // `data-kind` is the raw kind, unlocalised and independent of the
      // label — nothing styles on it today, so this assertion is its only
      // reader and the reason it is not dead weight.
      await expect(glyph).toHaveAttribute('data-kind', kind);
    }
  } finally {
    await booted.cleanup();
  }
});

test('a mounted leaf that becomes a parent picks up its persisted fold state', async () => {
  // A per-project watcher patch replaces only the changed item, and a card in
  // an untouched section is not remounted — so the fold's stored state has to
  // be read reactively off `children()`, not once at mount. Seed the map for
  // the sample project (a leaf at boot, in `now`), then make a `later` item its
  // child by editing that item's README, and expect the sample card's fold to
  // appear already open.
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      const dir = join(conceptionDir, 'projects', '2026-04', '2026-04-27-late-item');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'README.md'),
        `---\ndate: 2026-04-27\nkind: project\nstatus: later\n---\n\n# Late item\n\n## Goal\n\nBecomes a child mid-session.\n`,
        'utf8',
      );
    },
  });
  try {
    const win = booted.window;
    // Match on the card's own title: once the late item becomes a child, its
    // "Part of" banner carries "Sample project" too.
    const sample = win.locator('article.row', {
      has: win.locator('.title-text', { hasText: 'Sample project' }),
    });
    await expect(sample).toBeVisible();
    await expect(sample.locator('button.children-toggle')).toHaveCount(0);
    await win.evaluate(() => {
      window.localStorage.setItem(
        'condash:projects:section-collapse',
        JSON.stringify({ 'children.2026-04-26-sample': true }),
      );
    });

    await writeFile(
      join(booted.conceptionDir, 'projects', '2026-04', '2026-04-27-late-item', 'README.md'),
      `---\ndate: 2026-04-27\nkind: project\nstatus: later\nparent: 2026-04-26-sample\n---\n\n# Late item\n\n## Goal\n\nBecomes a child mid-session.\n`,
      'utf8',
    );

    const toggle = sample.locator('button.children-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
    await expect(sample).toHaveClass(/is-parent/);
    await expect(sample.locator('button.child-row')).toHaveCount(1);
  } finally {
    await booted.cleanup();
  }
});

test('clicking the card body (not the title) opens that project preview', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    await win.waitForSelector('article.row', { state: 'visible', timeout: 5000 });

    // The date span sits at the end of the meta row: not the title, not in
    // the click exclusion set (.row-action, .pr-badge, .title-actions,
    // banner buttons) — a plain body click that must bubble up to the
    // whole-card open.
    await win.click('article.row .date');

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

/**
 * The preview modal's kind glyph re-reads its kind when the previewed project
 * is swapped in place.
 *
 * The modal stays mounted across projects — the parent banner and the
 * Subprojects rows swap `props.project` rather than remounting — and the
 * `kind !== 'unknown'` gate around the glyph stays truthy across a
 * document → project switch, so `KindGlyph` is never re-created. That makes it
 * the one place where reading `KIND[props.kind]` in the component body instead
 * of through an accessor is observable: Solid re-runs the attribute effect on
 * a `props.kind` change either way, but a body-read `const` writes the same
 * frozen value back, and the card announces a project as "Document".
 *
 * Both halves are asserted because they froze independently: the label read
 * from a mount-time const, and the icon component resolved once at mount.
 */
test('the preview kind glyph follows an in-place project swap', async () => {
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      const parentDir = join(conceptionDir, 'projects', '2026-04', '2026-04-20-kind-parent');
      await mkdir(parentDir, { recursive: true });
      await writeFile(
        join(parentDir, 'README.md'),
        `---\ndate: 2026-04-20\nkind: project\nstatus: now\n---\n\n# Kind parent\n\n## Goal\n\nProject-kind fixture.\n`,
        'utf8',
      );
      const childDir = join(conceptionDir, 'projects', '2026-04', '2026-04-21-kind-child');
      await mkdir(childDir, { recursive: true });
      await writeFile(
        join(childDir, 'README.md'),
        `---\ndate: 2026-04-21\nkind: document\nstatus: now\nparent: 2026-04-20-kind-parent\n---\n\n# Kind child\n\n## Goal\n\nDocument-kind fixture.\n`,
        'utf8',
      );
    },
  });
  try {
    const win = booted.window;
    // Leftmost path of each hand-tuned outline: page body vs gem-cut diamond.
    const DOCUMENT_PATH = 'M2.5 2h6L12 5.5v9H2.5z';
    const PROJECT_PATH = 'M8 2.5L13.5 8 8 13.5 2.5 8z';

    await win
      .locator('article.row', { has: win.locator('.title-text', { hasText: 'Kind child' }) })
      .locator('.title-text')
      .click();
    const glyph = win.locator('.modal.project-preview .kind-glyph');
    await expect(glyph).toHaveAttribute('aria-label', 'Document');
    await expect(glyph.locator('svg path').first()).toHaveAttribute('d', DOCUMENT_PATH);

    // Swap the previewed project without remounting the modal.
    await win.click('.modal.project-preview button.parent-banner-name');
    await expect(win.locator('.modal.project-preview .modal-title')).toHaveText('Kind parent');

    await expect(glyph).toHaveAttribute('aria-label', 'Project');
    await expect(glyph).toHaveAttribute('data-kind', 'project');
    await expect(glyph.locator('svg path').first()).toHaveAttribute('d', PROJECT_PATH);
  } finally {
    await booted.cleanup();
  }
});
