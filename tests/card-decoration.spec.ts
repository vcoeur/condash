import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Hierarchy + active-tab card decoration (2026-08-24 project-card-hierarchy-
 * highlight).
 *
 * The corrected brief pins hierarchy to card decoration ONLY — cards are
 * never reordered, indented or nested to express it. The decoration is
 * directional: a card with one or more children wears a narrow SOLID LEFT
 * border, a card that declares a `parent:` wears a narrow DASHED RIGHT
 * border, and a mid-tree node wears both simultaneously. Projects linked to
 * the FOCUSED terminal tab keep the Linked-tabs fold and additionally wear a
 * prominent whole-card highlight (accent-tinted background + accent inset
 * ring), distinct from the family-coloured hierarchy edges, hover, focus and
 * star states.
 *
 * These specs assert the classes AND the computed border geometry, so a
 * regression that keeps the class but drops the geometry (or vice versa)
 * still fails. The border assertions are computed styles from
 * getComputedStyle, not the class list, because the classes only drive the
 * CSS — the geometry is the contract the brief pins.
 */

// A three-level family: root-plan (parent-only), leaf-impl (child-only),
// mid-plan (both — root-plan's child AND mid-child's parent) and mid-child
// (child-only). The built-in `2026-04-26-sample` fixture stays standalone.
const prepareHierarchy = async (conceptionDir: string): Promise<void> => {
  const month = join(conceptionDir, 'projects', '2026-04');
  await mkdir(join(month, '2026-04-20-root-plan'), { recursive: true });
  await writeFile(
    join(month, '2026-04-20-root-plan', 'README.md'),
    `---\ndate: 2026-04-20\nkind: project\nstatus: now\n---\n\n# Root plan\n\n## Goal\n\nParent-only fixture.\n`,
    'utf8',
  );
  await mkdir(join(month, '2026-04-21-leaf-impl'), { recursive: true });
  await writeFile(
    join(month, '2026-04-21-leaf-impl', 'README.md'),
    `---\ndate: 2026-04-21\nkind: project\nstatus: now\nparent: 2026-04-20-root-plan\n---\n\n# Leaf impl\n\n## Goal\n\nChild-only fixture.\n`,
    'utf8',
  );
  await mkdir(join(month, '2026-04-22-mid-plan'), { recursive: true });
  await writeFile(
    join(month, '2026-04-22-mid-plan', 'README.md'),
    `---\ndate: 2026-04-22\nkind: project\nstatus: now\nparent: 2026-04-20-root-plan\n---\n\n# Mid plan\n\n## Goal\n\nMid-tree fixture.\n`,
    'utf8',
  );
  await mkdir(join(month, '2026-04-23-mid-child'), { recursive: true });
  await writeFile(
    join(month, '2026-04-23-mid-child', 'README.md'),
    `---\ndate: 2026-04-23\nkind: project\nstatus: now\nparent: 2026-04-22-mid-plan\n---\n\n# Mid child\n\n## Goal\n\nMid-tree leaf fixture.\n`,
    'utf8',
  );
};

// A standalone sibling of the sample card, for "the highlight is off the
// neutral cards" comparisons.
const prepareSibling = async (conceptionDir: string): Promise<void> => {
  const dir = join(conceptionDir, 'projects', '2026-04', '2026-04-20-alpha');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'README.md'),
    `---\ndate: 2026-04-20\nkind: project\nstatus: now\n---\n\n# Alpha project\n\n## Goal\n\nStandalone sibling fixture.\n`,
    'utf8',
  );
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn a long-running `my`-side shell tab and wait for its tab row. */
async function spawnTab(window: Page, command: string): Promise<string> {
  const session = await window.evaluate(
    (cmd) => window.condash.termSpawn({ side: 'my', command: cmd }),
    command,
  );
  await window.waitForSelector(`[data-sid="${session.id}"]`, {
    state: 'attached',
    timeout: 10_000,
  });
  // Let reconcile mount the tab and the focus mirror publish.
  await wait(600);
  return session.id;
}

const cardTitled = (window: Page, title: string) =>
  window.locator('article.row', { has: window.locator('.title-text', { hasText: title }) });

test('a parent-only card wears a narrow solid left border and no right border', async () => {
  const booted = await bootApp({ prepare: prepareHierarchy });
  try {
    const win = booted.window;
    const parent = cardTitled(win, 'Root plan');
    await expect(parent).toHaveClass(/is-parent/);
    await expect(parent).not.toHaveClass(/is-subproject/);
    await expect(parent).toHaveCSS('border-left-width', '3px');
    await expect(parent).toHaveCSS('border-left-style', 'solid');
    await expect(parent).toHaveCSS('border-right-width', '0px');
  } finally {
    await booted.cleanup();
  }
});

test('a child-only card wears a narrow dashed right border and no left border', async () => {
  const booted = await bootApp({ prepare: prepareHierarchy });
  try {
    const win = booted.window;
    const child = cardTitled(win, 'Leaf impl');
    await expect(child).toHaveClass(/is-subproject/);
    await expect(child).not.toHaveClass(/is-parent/);
    await expect(child).toHaveCSS('border-right-width', '3px');
    await expect(child).toHaveCSS('border-right-style', 'dashed');
    await expect(child).toHaveCSS('border-left-width', '0px');
  } finally {
    await booted.cleanup();
  }
});

test('a mid-tree node wears both borders simultaneously', async () => {
  const booted = await bootApp({ prepare: prepareHierarchy });
  try {
    const win = booted.window;
    const mid = cardTitled(win, 'Mid plan');
    // Both relation classes land on the same card…
    await expect(mid).toHaveClass(/is-parent/);
    await expect(mid).toHaveClass(/is-subproject/);
    // …and the geometry keeps BOTH directional edges — the solid left must
    // not eat the dashed right (the old "parent wins" behaviour), and the
    // dashed right must not eat the solid left.
    await expect(mid).toHaveCSS('border-left-width', '3px');
    await expect(mid).toHaveCSS('border-left-style', 'solid');
    await expect(mid).toHaveCSS('border-right-width', '3px');
    await expect(mid).toHaveCSS('border-right-style', 'dashed');
    // Both edges keep the SAME family hue (--row-stripe from the base .row
    // declaration — the directional rules only touch width/style, never
    // color, so the shorthand can't reset one side to the text color).
    const edgeColors = await mid.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { left: cs.borderLeftColor, right: cs.borderRightColor };
    });
    expect(edgeColors.left).toBe(edgeColors.right);
  } finally {
    await booted.cleanup();
  }
});

test('a standalone card keeps the full neutral frame', async () => {
  const booted = await bootApp({ prepare: prepareHierarchy });
  try {
    const win = booted.window;
    const sample = cardTitled(win, 'Sample project');
    await expect(sample).not.toHaveClass(/is-parent/);
    await expect(sample).not.toHaveClass(/is-subproject/);
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      await expect(sample).toHaveCSS(`border-${side}-width`, '2px');
      await expect(sample).toHaveCSS(`border-${side}-style`, 'solid');
    }
  } finally {
    await booted.cleanup();
  }
});

test('a card linked to the focused tab wears the whole-card highlight, and it clears when focus leaves', async () => {
  const booted = await bootApp({ prepare: prepareSibling });
  try {
    const win = booted.window;
    const tab = await spawnTab(win, 'printf "READY\n"; sleep 30');
    const sample = cardTitled(win, 'Sample project');
    const sibling = cardTitled(win, 'Alpha project');

    // Pointer at the window corner so :hover never skews a computed style —
    // the card under the pointer matches .row:hover / .row.linked-active:hover.
    await win.mouse.move(0, 0);
    const neutralBg = await sample.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(neutralBg).not.toBe('');
    expect(await sibling.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(neutralBg);

    // Link the focused tab → the strong state AND the whole-card highlight:
    // the background is tinted away from neutral and an accent ring (inset
    // box-shadow) wraps the card. The unlinked sibling stays neutral.
    await sample.locator('.link-button').click();
    await expect(sample).toHaveClass(/linked-any/);
    await expect(sample).toHaveClass(/linked-active/);
    await win.mouse.move(0, 0);
    const highlightedBg = await sample.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(highlightedBg).not.toBe(neutralBg);
    expect(await sample.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('inset');
    expect(await sibling.evaluate((el) => getComputedStyle(el).boxShadow)).not.toContain('inset');

    // Focus moves to a NEW, unlinked tab → the highlight clears back to the
    // exact neutral background; the card keeps only the subtle fold accent.
    await spawnTab(win, 'printf "B\n"; sleep 30');
    await win.mouse.move(0, 0);
    await expect(sample).not.toHaveClass(/linked-active/);
    expect(await sample.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(neutralBg);
    expect(await sample.evaluate((el) => getComputedStyle(el).boxShadow)).not.toContain('inset');
    void tab;
  } finally {
    await booted.cleanup();
  }
});

test('the whole-card highlight coexists with both hierarchy edges on a linked mid-tree card', async () => {
  const booted = await bootApp({ prepare: prepareHierarchy });
  try {
    const win = booted.window;
    await spawnTab(win, 'printf "READY\n"; sleep 30');
    const mid = cardTitled(win, 'Mid plan');
    await mid.locator('.link-button').click();

    // The highlight must not displace the hierarchy decoration: the linked
    // mid-tree card keeps its solid left AND dashed right edges while the
    // accent inset ring wraps the whole card on top of them.
    await expect(mid).toHaveClass(/linked-active/);
    await expect(mid).toHaveCSS('border-left-style', 'solid');
    await expect(mid).toHaveCSS('border-right-style', 'dashed');
    await expect(mid).toHaveCSS('border-left-width', '3px');
    await expect(mid).toHaveCSS('border-right-width', '3px');
    expect(await mid.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('inset');
  } finally {
    await booted.cleanup();
  }
});
