import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * The Projects pane's spacing contract, as rendered.
 *
 * This exists because the pane's spacing is reasoned about in prose. The rules
 * carry long comments asserting geometry ("32px of bare background", "the row
 * floors at 20px on the star's box"), and those numbers are load-bearing —
 * they are the argument for why each value is what it is. Prose cannot be
 * wrong loudly: two review rounds on the density change found comments that had
 * drifted from the CSS they sat above, including one that stated an asymmetry
 * backwards and one that attributed a height to a border the rule had removed.
 *
 * Three things in particular are invisible to a reader of the CSS alone and are
 * what this spec is really guarding:
 *
 *   - `.projects-stack` is a flex column with `gap: 8px`, and a flex gap ADDS to
 *     a margin. Every margin in the section stack therefore renders 8px larger
 *     than it reads, which is why the 32px section margin produces a 40px gap.
 *   - The work-on control does not take the 26px box `.row .row-action`
 *     declares — `.action-dropdown-button.row-action.work-on` resets it to
 *     `width/height: auto` at higher specificity — so its height comes from its
 *     own padding, and the chrome row's real floor is the star's 20px box.
 *   - Done's month subgroups are `.group-block`s too. They are excluded from the
 *     section margins by a `.projects-stack > ` scope and by nothing else.
 *
 * Assertions are on the rendered geometry rather than on declarations, so a
 * change that alters the result through a different rule still trips.
 */

/** now ×2, review ×1, two empty lanes between review and done, done ×2 across
 *  two months — the shape that exercises every spacing rule at once. */
const seed = async (conceptionDir: string): Promise<void> => {
  const items: Array<[string, string, string, string]> = [
    ['2026-08', '2026-08-26-alpha', 'now', 'Alpha in now'],
    ['2026-08', '2026-08-25-beta', 'now', 'Beta in now'],
    ['2026-08', '2026-08-24-gamma', 'review', 'Gamma in review'],
    ['2026-07', '2026-07-10-delta', 'done', 'Delta done in July'],
    ['2026-06', '2026-06-10-epsilon', 'done', 'Epsilon done in June'],
  ];
  for (const [month, slug, status, title] of items) {
    const dir = join(conceptionDir, 'projects', month, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'README.md'),
      `---\ndate: ${slug.slice(0, 10)}\nkind: project\nstatus: ${status}\napps:\n  - condash\n---\n\n# ${title}\n\n## Goal\n\nSpacing fixture.\n\n## Timeline\n\n- ${slug.slice(0, 10)} — Closed.\n`,
      'utf8',
    );
  }
};

test.describe('Projects pane spacing', () => {
  test('cards, sections and empty lanes render their declared distances', async () => {
    const booted = await bootApp({
      globalConfig: {
        theme: 'dark',
        layout: { projects: true, leftView: 'projects', terminal: false },
      },
      prepare: seed,
    });
    const page = booted.window;
    try {
      await page.waitForSelector('.projects-stack .row', { timeout: 30_000 });

      const geometry = await page.evaluate(() => {
        const round = (n: number): number => Math.round(n);
        const rect = (el: Element): DOMRect => el.getBoundingClientRect();
        const lanes = Array.from(document.querySelectorAll('.projects-stack > .group-block'));
        const at = (status: string): Element =>
          lanes.find((el) => el.getAttribute('data-status') === status)!;
        const isEmpty = (el: Element): boolean => el.getAttribute('data-empty') === 'true';
        const gapBetween = (a: Element, b: Element): number => round(rect(b).top - rect(a).bottom);

        const now = at('now');
        const review = at('review');
        const firstEmpty = lanes.find(isEmpty)!;
        const panelAboveEmpty = lanes[lanes.indexOf(firstEmpty) - 1];
        const panelBelowLastEmpty = (() => {
          let i = lanes.indexOf(firstEmpty);
          while (i < lanes.length && isEmpty(lanes[i])) i += 1;
          return lanes[i];
        })();
        const lastEmpty = lanes[lanes.indexOf(panelBelowLastEmpty) - 1];

        const cards = Array.from(now.querySelectorAll('.row'));
        const card = cards[0];

        return {
          cardGap: gapBetween(cards[0], cards[1]),
          sectionGap: gapBetween(now, review),
          aboveEmptyLane: gapBetween(panelAboveEmpty, firstEmpty),
          belowEmptyLane: gapBetween(lastEmpty, panelBelowLastEmpty),
          emptyLaneHasNoPanelChrome:
            getComputedStyle(firstEmpty).borderTopWidth === '0px' &&
            getComputedStyle(firstEmpty).backgroundColor === 'rgba(0, 0, 0, 0)',
          panelBorderWidth: getComputedStyle(now).borderTopWidth,
          panelRadius: getComputedStyle(now).borderTopLeftRadius,
          headerHasNoRule: getComputedStyle(now.querySelector('.group-header')!).borderBottomWidth,
          headRowHeight: round(rect(card.querySelector('.head-row')!).height),
          starBox: round(rect(card.querySelector('.star-toggle')!).height),
          workOnHeight: round(
            rect(card.querySelector('.title-actions .action-dropdown-button.row-action')!).height,
          ),
        };
      });

      // Cards are discrete objects; sections are an order further apart. The
      // 40px is the 32px margin plus the stack's own 8px flex gap.
      expect(geometry.cardGap).toBe(20);
      expect(geometry.sectionGap).toBe(40);
      expect(geometry.sectionGap).toBeGreaterThan(geometry.cardGap);

      // An empty lane floats between two panels rather than reading as the
      // footer of the one above it: near-symmetric, never flush.
      expect(geometry.aboveEmptyLane).toBe(32);
      expect(geometry.belowEmptyLane).toBe(40);
      expect(geometry.emptyLaneHasNoPanelChrome).toBe(true);

      // The panel's drawn edge, quieter than a card's 2px frame.
      expect(geometry.panelBorderWidth).toBe('1px');
      expect(geometry.panelRadius).toBe('12px');
      // Redundant once the panel has an edge — removing it is deliberate.
      expect(geometry.headerHasNoRule).toBe('0px');

      // The chrome row floors on the star, NOT on the work-on control: the
      // control is shorter, so trimming it further would only cost hit area.
      expect(geometry.starBox).toBe(20);
      expect(geometry.headRowHeight).toBe(20);
      expect(geometry.workOnHeight).toBe(19);
      expect(geometry.workOnHeight).toBeLessThan(geometry.headRowHeight);
    } finally {
      await booted.cleanup();
    }
  });

  test('Done month subgroups separate below the section order', async () => {
    const booted = await bootApp({
      globalConfig: {
        theme: 'dark',
        layout: { projects: true, leftView: 'projects', terminal: false },
      },
      prepare: seed,
    });
    const page = booted.window;
    try {
      await page.waitForSelector('.projects-stack .row', { timeout: 30_000 });
      await page
        .locator('.projects-stack > .group-block[data-status="done"] > .group-header')
        .click();
      await page.waitForSelector('.group-block.subgroup', { timeout: 10_000 });

      const margins = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.group-block.subgroup')).map(
          (el) => getComputedStyle(el).marginTop,
        ),
      );

      // Two months: the first flush to the section header, the rest a step
      // below the 32px that separates whole sections. A subgroup carries no
      // `data-empty`, so only the `.projects-stack > ` scope on the section
      // margins keeps it off 32px — that is what this pins.
      expect(margins.length).toBeGreaterThanOrEqual(2);
      expect(margins[0]).toBe('0px');
      expect(margins.slice(1)).toEqual(margins.slice(1).map(() => '16px'));
    } finally {
      await booted.cleanup();
    }
  });

  test('Console keeps its crisper panel corner', async () => {
    const booted = await bootApp({
      globalConfig: {
        theme: 'console',
        layout: { projects: true, leftView: 'projects', terminal: false },
      },
      prepare: seed,
    });
    const page = booted.window;
    try {
      await page.waitForSelector('.projects-stack .row', { timeout: 30_000 });
      const radius = await page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector('.projects-stack > .group-block[data-status="now"]')!,
          ).borderTopLeftRadius,
      );
      // The panel uses --radius-lg rather than a literal, which is the whole
      // reason Console's "a TUI draws boxes, not pills" override still reaches it.
      expect(radius).toBe('8px');
    } finally {
      await booted.cleanup();
    }
  });
});
