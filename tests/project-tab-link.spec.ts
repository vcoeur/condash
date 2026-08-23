import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Manual card ↔ terminal-tab links, end to end through the real UI.
 *
 * What warrants an app-level spec: the link is a renderer-only feature, but
 * its wiring crosses surfaces — the controller's focus mirror (a createEffect
 * over controller signals feeding a module store), the card's Link button
 * (disabled/enabled by that mirror), the chip-as-button that opens the
 * portaled linked-tabs popover (where the per-tab focus/unlink rows now
 * live), the decoration classes, the Active-tab filter, the tab hover
 * popover, the context menu, and the prune/re-point lifecycle hooks. Unit
 * tests pin the store and the controller pieces; these tests drive the real
 * gestures against the built app.
 *
 * The fixture ships `2026-04-26-sample` in `now`; `prepare` adds an older
 * sibling so "one tab links two projects" has a second card.
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

/** The persisted link map, as localStorage holds it. */
async function linksOnDisk(
  window: Page,
): Promise<Record<string, Record<string, { label: string }>>> {
  return window.evaluate(() => {
    const raw = localStorage.getItem('condash:term:links:v1');
    return raw ? (JSON.parse(raw) as Record<string, Record<string, { label: string }>>) : {};
  });
}

const sampleCard = (window: Page) => window.locator('article.row', { hasText: 'Sample project' });

test('the Link button is disabled with no focused tab and enabled once a tab is open', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    await expect(sampleCard(win).locator('.link-button')).toBeDisabled();

    await spawnTab(win, 'printf "READY\n"; sleep 30');
    await expect(sampleCard(win).locator('.link-button')).toBeEnabled();
  } finally {
    await booted.cleanup();
  }
});

test('linking adds one relation — the card gains the chip, the popover row, and the decoration', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    const tab = await spawnTab(win, 'printf "READY\n"; sleep 30');

    await sampleCard(win).locator('.link-button').click();

    // The focused tab is the linked one → the strong state immediately.
    const card = sampleCard(win);
    await expect(card).toHaveClass(/linked-active/);
    await expect(card).toHaveClass(/linked-any/);
    await expect(card.locator('.linked-tabs-chip')).toHaveText('1 tab');

    // The chip opens the portaled linked-tabs popover, which carries the
    // per-tab rows the relations zone used to hold.
    await card.locator('.linked-tabs-chip').click();
    const popover = win.locator('.linked-tabs-popover');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.link-row')).toHaveCount(1);
    // A plain spawned shell carries no OSC 7 / repo, so the label captured at
    // link time is the generic 'shell'.
    await expect(popover.locator('.link-row-label')).toHaveText('shell');
    await expect
      .poll(() => linksOnDisk(win), { timeout: 5000 })
      .toMatchObject({ '2026-04-26-sample': { [tab]: { label: 'shell' } } });

    // Re-linking the same pair is a no-op — one row, one record.
    await win.keyboard.press('Escape');
    await sampleCard(win).locator('.link-button').click();
    await sampleCard(win).locator('.linked-tabs-chip').click();
    await expect(win.locator('.linked-tabs-popover .link-row')).toHaveCount(1);
    await expect(sampleCard(win).locator('.linked-tabs-chip')).toHaveText('1 tab');
    await expect
      .poll(() => linksOnDisk(win), { timeout: 5000 })
      .toMatchObject({ '2026-04-26-sample': { [tab]: { label: 'shell' } } });
  } finally {
    await booted.cleanup();
  }
});

test('the chip is a button that opens the popover; outside-click and Escape close it', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    await spawnTab(win, 'printf "READY\n"; sleep 30');
    await sampleCard(win).locator('.link-button').click();

    const chip = sampleCard(win).locator('.linked-tabs-chip');
    await expect(chip).toHaveText('1 tab');
    // The chip is a real button carrying the disclosure state.
    expect(await chip.evaluate((el) => el.tagName)).toBe('BUTTON');
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(chip).toHaveAttribute('aria-haspopup', 'dialog');

    // Click opens the portaled popover.
    await chip.click();
    const popover = win.locator('.linked-tabs-popover');
    await expect(popover).toBeVisible();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    // The popover escaped the card: `.row` sets `contain: layout paint`,
    // which would clip an inline overlay — it must sit in document.body.
    expect(await popover.evaluate((el) => el.closest('.row') === null)).toBe(true);

    // Outside-click closes it.
    await win.locator('.pane-header-title').click();
    await expect(popover).toHaveCount(0);
    await expect(chip).toHaveAttribute('aria-expanded', 'false');

    // Re-open, then Escape closes it.
    await chip.click();
    await expect(win.locator('.linked-tabs-popover')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.locator('.linked-tabs-popover')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});

test('many-to-many — one project links two tabs; both rows survive, decoration drops to subtle', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    const a = await spawnTab(win, 'printf "A\n"; sleep 30');
    await sampleCard(win).locator('.link-button').click();
    // Spawning a second tab moves the focus off the first — the card drops
    // from the strong to the subtle strength.
    await spawnTab(win, 'printf "B\n"; sleep 30');
    await sampleCard(win).locator('.link-button').click();
    // A THIRD, unlinked tab: now neither linked tab is focused, so the card
    // reads in the subtle strength (any-live) rather than strong (focused).
    await spawnTab(win, 'printf "C\n"; sleep 30');

    const card = sampleCard(win);
    await expect(card.locator('.linked-tabs-chip')).toHaveText('2 tabs');
    // Open the popover: both rows, in link order.
    await card.locator('.linked-tabs-chip').click();
    const popover = win.locator('.linked-tabs-popover');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.link-row')).toHaveCount(2);
    await expect(popover.locator('.link-row-label')).toHaveText(['shell', 'shell']);
    await expect(card).toHaveClass(/linked-any/);
    await expect(card).not.toHaveClass(/linked-active/);

    // Focus the first linked tab again → strong state returns. (Clicking the
    // tab is also an outside-click, which closes the popover.)
    await win.locator(`[data-sid="${a}"]`).click();
    await expect(card).toHaveClass(/linked-active/);
  } finally {
    await booted.cleanup();
  }
});

test('the focus arrow activates the linked tab', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    const a = await spawnTab(win, 'printf "A\n"; sleep 30');
    await sampleCard(win).locator('.link-button').click();
    const b = await spawnTab(win, 'printf "B\n"; sleep 30');
    await expect(win.locator(`[data-sid="${b}"]`)).toHaveClass(/active/);

    // The focus arrow lives in the chip popover now — open it first.
    await sampleCard(win).locator('.linked-tabs-chip').click();
    const popover = win.locator('.linked-tabs-popover');
    await expect(popover).toBeVisible();
    await popover.locator('.link-row-focus').first().click();

    await expect(win.locator(`[data-sid="${a}"]`)).toHaveClass(/active/);
    await expect(win.locator(`[data-sid="${b}"]`)).not.toHaveClass(/active/);
  } finally {
    await booted.cleanup();
  }
});

test('unlink one from the popover clears exactly that relation', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    const a = await spawnTab(win, 'printf "A\n"; sleep 30');
    await sampleCard(win).locator('.link-button').click();
    const b = await spawnTab(win, 'printf "B\n"; sleep 30');
    await sampleCard(win).locator('.link-button').click();
    // Unlink lives in the chip popover now — open it and remove the first row.
    await sampleCard(win).locator('.linked-tabs-chip').click();
    const popover = win.locator('.linked-tabs-popover');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.link-row')).toHaveCount(2);
    await popover.locator('.link-row-unlink').first().click();

    // One row left → the popover stays open; the chip drops to "1 tab".
    await expect(popover.locator('.link-row')).toHaveCount(1);
    await expect(sampleCard(win).locator('.linked-tabs-chip')).toHaveText('1 tab');
    await expect
      .poll(() => linksOnDisk(win), { timeout: 5000 })
      .toMatchObject({ '2026-04-26-sample': { [b]: { label: 'shell' } } });
  } finally {
    await booted.cleanup();
  }
});

test('the tab context menu unlinks one project, and unlink-all clears every relation', async () => {
  const booted = await bootApp({ prepare: prepareSibling });
  try {
    const win = booted.window;
    const tab = await spawnTab(win, 'printf "READY\n"; sleep 30');
    await sampleCard(win).locator('.link-button').click();
    await win.locator('article.row', { hasText: 'Alpha project' }).locator('.link-button').click();
    await expect(win.locator('article.row')).toHaveCount(2);

    // Right-click the linked tab: one danger item per project + unlink-all.
    await win.locator(`[data-sid="${tab}"]`).click({ button: 'right' });
    const menu = win.locator('.terminal-tab-context-menu.portal');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.terminal-tab-context-menu-label')).toHaveText('Linked projects');
    await expect(
      menu.locator('.terminal-tab-context-menu-item', { hasText: 'Unlink from' }),
    ).toHaveCount(2);
    await expect(
      menu.locator('.terminal-tab-context-menu-item', { hasText: 'Unlink all projects (2)' }),
    ).toHaveCount(1);

    // Unlink ALL — both cards lose their link surface in one write. The chip
    // is the card's only signal now, so its disappearance is the "no rows"
    // assertion.
    await menu
      .locator('.terminal-tab-context-menu-item', { hasText: 'Unlink all projects (2)' })
      .click();
    await expect(sampleCard(win).locator('.linked-tabs-chip')).toHaveCount(0);
    await expect(
      win.locator('article.row', { hasText: 'Alpha project' }).locator('.linked-tabs-chip'),
    ).toHaveCount(0);
    await expect(sampleCard(win)).not.toHaveClass(/linked-any/);
    await expect.poll(() => linksOnDisk(win), { timeout: 5000 }).toEqual({});

    // Unlink ONE from the menu — re-link just the sample card first. With a
    // single project left, unlink-one and unlink-all coincide: the menu shows
    // only the item, never an "Unlink all projects (1)".
    await sampleCard(win).locator('.link-button').click();
    await win.locator(`[data-sid="${tab}"]`).click({ button: 'right' });
    const menu2 = win.locator('.terminal-tab-context-menu.portal');
    await expect(menu2).toBeVisible();
    await expect(
      menu2.locator('.terminal-tab-context-menu-item', {
        hasText: 'Unlink from 2026-04-26-sample',
      }),
    ).toHaveCount(1);
    await expect(
      menu2.locator('.terminal-tab-context-menu-item', { hasText: 'Unlink all' }),
    ).toHaveCount(0);
    await menu2
      .locator('.terminal-tab-context-menu-item', { hasText: 'Unlink from 2026-04-26-sample' })
      .click();
    await expect(sampleCard(win).locator('.linked-tabs-chip')).toHaveCount(0);
    await expect.poll(() => linksOnDisk(win), { timeout: 5000 }).toEqual({});
  } finally {
    await booted.cleanup();
  }
});

test('the Active-tab filter keeps only projects linked to the focused tab and ANDs with other filters', async () => {
  const booted = await bootApp({ prepare: prepareSibling });
  try {
    const win = booted.window;
    // No focused tab → the toggle is disabled.
    await expect(win.locator('.projects-filter-active-tab')).toBeDisabled();

    const a = await spawnTab(win, 'printf "A\n"; sleep 30');
    await expect(win.locator('.projects-filter-active-tab')).toBeEnabled();
    await sampleCard(win).locator('.link-button').click();

    // Filter on: only the linked sample card stays, N of M shows the count.
    await win.locator('.projects-filter-active-tab').click();
    await expect(win.locator('.projects-filter-active-tab')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(win.locator('article.row')).toHaveCount(1);
    await expect(sampleCard(win)).toBeVisible();
    await expect(win.locator('.projects-filter-count')).toHaveText('1 of 2');

    // Focus a DIFFERENT, unlinked tab: everything hides — 0 of N is a true result.
    const b = await spawnTab(win, 'printf "B\n"; sleep 30');
    await expect(win.locator('article.row')).toHaveCount(0);
    await expect(win.locator('.projects-filter-count')).toHaveText('0 of 2');
    await expect(win.locator('.projects-filter-empty')).toContainText(
      'No item matches the current filters',
    );

    // Focus the linked tab again → the sample card returns.
    await win.locator(`[data-sid="${a}"]`).click();
    await expect(win.locator('article.row')).toHaveCount(1);

    // ANDs with the starred filter: sample isn't starred → nothing shows.
    await win.locator('.projects-filter-starred').click();
    await expect(win.locator('article.row')).toHaveCount(0);

    // Clear filters → both cards back.
    await win.locator('.projects-filter-reset').click();
    await expect(win.locator('article.row')).toHaveCount(2);
  } finally {
    await booted.cleanup();
  }
});

test('hovering a linked tab lists its projects in the popover (no Dashboard needed)', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    const tab = await spawnTab(win, 'printf "READY\n"; sleep 30');
    await sampleCard(win).locator('.link-button').click();

    await win.locator(`[data-sid="${tab}"]`).hover();
    const popover = win.locator('.terminal-tab-popover.portal');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.terminal-tab-popover-links-head')).toHaveText('Linked projects');
    await expect(popover.locator('.terminal-tab-popover-links-list')).toContainText(
      '2026-04-26-sample',
    );
  } finally {
    await booted.cleanup();
  }
});

test('closing a tab clears every relation of it — chip and decoration go away', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    const tab = await spawnTab(win, 'printf "READY\n"; sleep 30');
    await sampleCard(win).locator('.link-button').click();
    await expect(sampleCard(win).locator('.linked-tabs-chip')).toHaveText('1 tab');

    // Open the popover, then close the tab from the terminal side — an
    // external removal (the reconcile's prune, not an in-popover unlink)
    // while the popover is open must close it too, or an empty popover
    // would float at a stale anchor.
    await sampleCard(win).locator('.linked-tabs-chip').click();
    await expect(win.locator('.linked-tabs-popover')).toBeVisible();

    await win.evaluate((sid) => window.condash.termClose(sid), tab);

    await expect(win.locator('.linked-tabs-popover')).toHaveCount(0);
    // The chip is the card's only link surface now — its disappearance is the
    // "rows gone" signal, and with it the decoration.
    await expect(sampleCard(win).locator('.linked-tabs-chip')).toHaveCount(0);
    await expect(sampleCard(win)).not.toHaveClass(/linked-any/);
    await expect.poll(() => linksOnDisk(win), { timeout: 5000 }).toEqual({});
  } finally {
    await booted.cleanup();
  }
});

test('a Restart re-points the links onto the new session id', async () => {
  const booted = await bootApp();
  try {
    const win = booted.window;
    // A non-zero exit is an abnormal death: main keeps the dead row (with its
    // Restart button) instead of auto-closing the tab.
    const session = await win.evaluate(() =>
      window.condash.termSpawn({ side: 'my', command: "sh -c 'exit 7'" }),
    );
    await win.waitForSelector(`[data-sid="${session.id}"] .terminal-tab-restart`, {
      state: 'attached',
      timeout: 15_000,
    });
    await sampleCard(win).locator('.link-button').click();
    await expect(sampleCard(win).locator('.linked-tabs-chip')).toHaveText('1 tab');

    await win.locator(`[data-sid="${session.id}"] .terminal-tab-restart`).click();

    // The restarted tab appears under a NEW sid — the old row is retired. The
    // card keeps exactly one row and the persisted map has moved to the new id.
    await expect
      .poll(
        async () =>
          win.evaluate(() => {
            const raw = localStorage.getItem('condash:term:links:v1');
            return raw ? Object.keys(JSON.parse(raw)['2026-04-26-sample'] ?? {}) : [];
          }),
        { timeout: 15_000 },
      )
      .toHaveLength(1);
    const sids = await win.evaluate(() => {
      const raw = localStorage.getItem('condash:term:links:v1');
      return raw ? Object.keys(JSON.parse(raw)['2026-04-26-sample'] ?? {}) : [];
    });
    expect(sids[0]).not.toBe(session.id);
    // The chip opens the popover: the re-pointed relation is one row, and the
    // label captured at link time ('shell') rides the re-point untouched.
    await sampleCard(win).locator('.linked-tabs-chip').click();
    const popover = win.locator('.linked-tabs-popover');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.link-row')).toHaveCount(1);
    await expect(popover.locator('.link-row-label')).toHaveText('shell');
  } finally {
    await booted.cleanup();
  }
});
