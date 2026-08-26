import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * The Projects pane's spacing contract, as rendered.
 *
 * This exists because the pane's spacing is reasoned about in prose. The rules
 * carry long comments asserting geometry ("a single dim line", "the row floors
 * at 20px on the star's box"), and those numbers are load-bearing —
 * they are the argument for why each value is what it is. Prose cannot be
 * wrong loudly: two review rounds found comments that had drifted from the CSS
 * they sat above, including one that stated an asymmetry backwards and one that
 * attributed a height to a border the rule had removed.
 *
 * Three things here are invisible to a reader of the CSS alone, and are what
 * this spec is really guarding:
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
 * **Assert rendered distances, never declarations.** A `marginTop` readback is
 * blind to the one failure mode this file exists for — a container gap silently
 * adding to the margin — so every distance below is measured between two
 * rectangles. There are exactly two exceptions, the stack's own `gap` and the
 * section `margin-top`, asserted as declarations *because* they are the shared
 * premise of all those comments: pinning only the sums would let someone
 * rebalance gap against margin and leave every number in the prose false while
 * the suite stayed green.
 *
 * **What belongs here.** Every geometry fact a comment actually claims — in
 * this file or in the rules it covers. That is the completion bar and also the
 * limit: paddings and sizes no comment argues for are deliberately not pinned,
 * because a test that freezes every number stops being a contract and starts
 * being a diff.
 */

/** `now` ×3 (two seeded here plus the `2026-04-26-sample` every `bootApp`
 *  fixture carries), `review` ×1, `later`/`backlog` empty, `done` ×2 across two
 *  months — the shape that exercises every spacing rule at once. */
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
    // The `Closed.` entry is what buckets a done item into its month subgroup,
    // so it belongs only on the done items — on a live one it is incoherent.
    const timeline = status === 'done' ? `\n## Timeline\n\n- ${slug.slice(0, 10)} — Closed.\n` : '';
    await writeFile(
      join(dir, 'README.md'),
      `---\ndate: ${slug.slice(0, 10)}\nkind: project\nstatus: ${status}\napps:\n  - condash\n---\n\n# ${title}\n\n## Goal\n\nSpacing fixture.\n${timeline}`,
      'utf8',
    );
  }
};

const boot = (theme: 'dark' | 'console') =>
  bootApp({
    globalConfig: { theme, layout: { projects: true, leftView: 'projects', terminal: false } },
    prepare: seed,
  });

test.describe('Projects pane spacing', () => {
  test('cards, sections and empty lanes render their declared distances', async () => {
    // An Electron cold start can eat most of the default 30s budget, which
    // would otherwise expire before the in-page waits could report anything.
    test.setTimeout(90_000);
    const booted = await boot('dark');
    const page = booted.window;
    try {
      await page.waitForSelector('.projects-stack .row', { timeout: 30_000 });

      const geometry = await page.evaluate(() => {
        const round = (n: number): number => Math.round(n);
        const rect = (el: Element): DOMRect => el.getBoundingClientRect();
        const gapBetween = (a: Element, b: Element): number => round(rect(b).top - rect(a).bottom);
        const stack = document.querySelector('.projects-stack')!;
        const lanes = Array.from(stack.querySelectorAll(':scope > .group-block'));
        const at = (status: string): Element =>
          lanes.find((el) => el.getAttribute('data-status') === status)!;

        // Mirrors the CSS selector, which excludes `now` from the empty-lane
        // margin. This fixture always has cards in `now`, so the exclusion
        // never fires here — the mirror keeps the predicate correct, it does
        // not cover that branch, which stays untested.
        const isEmptyLane = (el: Element): boolean =>
          el.getAttribute('data-empty') === 'true' && el.getAttribute('data-status') !== 'now';
        const firstEmptyIndex = lanes.findIndex(isEmptyLane);
        let lastEmptyIndex = firstEmptyIndex;
        while (
          firstEmptyIndex >= 0 &&
          lastEmptyIndex + 1 < lanes.length &&
          isEmptyLane(lanes[lastEmptyIndex + 1])
        ) {
          lastEmptyIndex += 1;
        }
        // Every index below is guarded, so a fixture that stopped producing
        // empty lanes reports through `laneOrder` instead of throwing an opaque
        // getComputedStyle TypeError before any assertion can run.
        const firstEmpty = firstEmptyIndex >= 0 ? lanes[firstEmptyIndex] : null;
        const lastEmpty = firstEmptyIndex >= 0 ? lanes[lastEmptyIndex] : null;
        const above = firstEmptyIndex > 0 ? lanes[firstEmptyIndex - 1] : null;
        const below = firstEmptyIndex >= 0 ? (lanes[lastEmptyIndex + 1] ?? null) : null;

        const now = at('now');
        const stackBox = rect(stack);
        const cards = Array.from(now.querySelectorAll('.row'));
        const card = cards[0] ?? null;
        const root = getComputedStyle(document.documentElement);

        return {
          laneOrder: lanes.map(
            (el) => `${el.getAttribute('data-status')}${isEmptyLane(el) ? ':empty' : ''}`,
          ),
          emptyLaneHasPanelAbove: above !== null,
          emptyLaneHasPanelBelow: below !== null,
          cardCount: cards.length,
          cardGap: cards.length > 1 ? gapBetween(cards[0], cards[1]) : null,
          // One column at this window width. Side-by-side cards would make
          // `cardGap` a large negative pointing nowhere near the cause, so the
          // premise is asserted rather than assumed.
          cardsShareAColumn:
            cards.length > 1 ? round(rect(cards[0]).left) === round(rect(cards[1]).left) : null,
          sectionGap: gapBetween(now, at('review')),
          // The `:not(:first-child)` half of the section-margin selector: the
          // top panel sits flush to the stack, carrying no margin of its own.
          topPanelOffset: lanes.length ? round(rect(lanes[0]).top - stackBox.top) : null,
          aboveEmptyLane: above && firstEmpty ? gapBetween(above, firstEmpty) : null,
          belowEmptyLane: below && lastEmpty ? gapBetween(lastEmpty, below) : null,
          // Both surrounding gaps are immune to the lane's own height, so the
          // "single dim line" claim needs its own assertion.
          emptyLaneHeight: firstEmpty ? round(rect(firstEmpty).height) : null,
          betweenEmptyLanes:
            lastEmptyIndex > firstEmptyIndex && firstEmptyIndex >= 0
              ? gapBetween(lanes[firstEmptyIndex], lanes[firstEmptyIndex + 1])
              : null,
          // Asserted directly, not inferred: this is the premise every spacing
          // comment in the pane is written against.
          stackRowGap: getComputedStyle(stack).rowGap,
          sectionMarginTop: getComputedStyle(at('review')).marginTop,
          emptyLaneBorder: firstEmpty ? getComputedStyle(firstEmpty).borderTopWidth : null,
          emptyLaneBackground: firstEmpty ? getComputedStyle(firstEmpty).backgroundColor : null,
          panelBorderWidth: getComputedStyle(now).borderTopWidth,
          // The panel edge is justified relative to the card frame, so assert
          // the relationship rather than only the absolute.
          cardBorderWidth: card ? getComputedStyle(card).borderTopWidth : null,
          panelRadius: getComputedStyle(now).borderTopLeftRadius,
          radiusLgToken: root.getPropertyValue('--radius-lg').trim(),
          headerRule: getComputedStyle(now.querySelector('.group-header')!).borderBottomWidth,
          headRowHeight: card ? round(rect(card.querySelector('.head-row')!).height) : null,
          starBox: card ? round(rect(card.querySelector('.star-toggle')!).height) : null,
          workOnHeight: card
            ? round(
                rect(card.querySelector('.title-actions .action-dropdown-button.row-action')!)
                  .height,
              )
            : null,
        };
      });

      expect(geometry.laneOrder).toEqual(['now', 'review', 'later:empty', 'backlog:empty', 'done']);
      expect(geometry.emptyLaneHasPanelAbove).toBe(true);
      expect(geometry.emptyLaneHasPanelBelow).toBe(true);
      expect(geometry.cardCount).toBe(3);
      expect(geometry.cardsShareAColumn).toBe(true);

      // The premise, pinned on its own so the sums below cannot be rebalanced
      // against it while every comment naming 8px / 32px quietly goes false.
      expect(geometry.stackRowGap).toBe('8px');
      expect(geometry.sectionMarginTop).toBe('32px');

      // Cards are discrete objects; sections are an order further apart. The
      // 40px is that 32px margin plus the stack's 8px gap.
      expect(geometry.cardGap).toBe(20);
      expect(geometry.sectionGap).toBe(40);
      expect(geometry.sectionGap).toBeGreaterThan(geometry.cardGap!);

      // An empty lane floats between two panels rather than reading as the
      // footer of the one above it: near-symmetric, never flush.
      expect(geometry.aboveEmptyLane).toBe(32);
      expect(geometry.belowEmptyLane).toBe(40);
      expect(geometry.betweenEmptyLanes).toBe(32);
      // "Empty sections collapse to a single dim line" — a line, not a panel.
      expect(geometry.emptyLaneHeight).toBe(25);
      // The first panel carries no margin of its own.
      expect(geometry.topPanelOffset).toBe(0);
      expect(geometry.emptyLaneBorder).toBe('0px');
      expect(geometry.emptyLaneBackground).toBe('rgba(0, 0, 0, 0)');

      // The panel's drawn edge, quieter than a card's 2px frame. Compared
      // against the live token, not a literal: the point of `var(--radius-lg)`
      // is that a re-tune reaches the panel, so a re-tune must not fail this.
      expect(geometry.panelBorderWidth).toBe('1px');
      expect(geometry.cardBorderWidth).toBe('2px');
      expect(Number.parseFloat(geometry.panelBorderWidth)).toBeLessThan(
        Number.parseFloat(geometry.cardBorderWidth!),
      );
      expect(geometry.panelRadius).toBe(geometry.radiusLgToken);
      // Redundant once the panel has an edge — removing it is deliberate.
      expect(geometry.headerRule).toBe('0px');

      // The chrome row floors on the star, NOT on the work-on control: the
      // control is shorter, so trimming it further would only cost hit area.
      expect(geometry.headRowHeight).toBe(geometry.starBox);
      expect(geometry.starBox).toBe(20);
      expect(geometry.workOnHeight).toBeLessThan(geometry.headRowHeight);
    } finally {
      await booted.cleanup();
    }
  });

  test('Done month subgroups separate below the section order', async () => {
    test.setTimeout(90_000);
    const booted = await boot('dark');
    const page = booted.window;
    try {
      await page.waitForSelector('.projects-stack .row', { timeout: 30_000 });
      // `done` is collapsed by default today; toggle only if it actually is, so
      // a change to that default cannot turn this into a collapse.
      const done = page.locator('.projects-stack > .group-block[data-status="done"]');
      if (await done.evaluate((el) => el.classList.contains('collapsed'))) {
        await done.locator('> .group-header').click();
      }
      await page.waitForSelector('.group-block.subgroup', { timeout: 10_000 });

      const subgroups = await page.evaluate(() => {
        const round = (n: number): number => Math.round(n);
        const rect = (el: Element): DOMRect => el.getBoundingClientRect();
        const section = document.querySelector(
          '.projects-stack > .group-block[data-status="done"]',
        )!;
        const header = section.querySelector(':scope > .group-header')!;
        const blocks = Array.from(section.querySelectorAll('.group-block.subgroup'));
        return {
          labels: blocks.map((el) => el.querySelector('.name')?.textContent ?? ''),
          // `.group-block.subgroup:first-child { margin-top: 0 }` — deleting it
          // is otherwise invisible to every gap measured below.
          firstOffsetFromHeader: blocks.length
            ? round(rect(blocks[0]).top - rect(header).bottom)
            : null,
          // Rendered distances, so a gap added to `.group-body.subgroups` cannot
          // hide behind an unchanged `margin-top`.
          gaps: blocks.slice(1).map((el, i) => round(rect(el).top - rect(blocks[i]).bottom)),
        };
      });

      // Two months, newest first. The first sits flush under the section
      // header; the rest separate a step below the 32px between whole sections.
      // A subgroup carries no `data-empty`, so only the `.projects-stack > `
      // scope on the section margin keeps it off 32px — that is what this pins.
      expect(subgroups.labels).toEqual(['2026-07', '2026-06']);
      expect(subgroups.firstOffsetFromHeader).toBe(0);
      expect(subgroups.gaps).toEqual([16]);
    } finally {
      await booted.cleanup();
    }
  });

  test('a done card floors its chrome row on the Link button instead of the star', async () => {
    test.setTimeout(90_000);
    const booted = await boot('dark');
    const page = booted.window;
    try {
      await page.waitForSelector('.projects-stack .row', { timeout: 30_000 });
      const done = page.locator('.projects-stack > .group-block[data-status="done"]');
      if (await done.evaluate((el) => el.classList.contains('collapsed'))) {
        await done.locator('> .group-header').click();
      }
      await page.waitForSelector('.group-block[data-status="done"] .row', { timeout: 10_000 });

      const doneCard = await page.evaluate(() => {
        const round = (n: number): number => Math.round(n);
        const rect = (el: Element): DOMRect => el.getBoundingClientRect();
        const card = document.querySelector('.group-block[data-status="done"] .row')!;
        return {
          hasStar: card.querySelector('.star-toggle') !== null,
          headRow: round(rect(card.querySelector('.head-row')!).height),
          link: round(rect(card.querySelector('.link-button')!).height),
          workOn: round(
            rect(card.querySelector('.title-actions .action-dropdown-button.row-action')!).height,
          ),
        };
      });

      // The CSS justifies the work-on control's padding partly by "a done card
      // renders no star, so there the floor is the 19px Link button and this
      // control matches it exactly". That is a relationship, so assert the
      // relationship — a change to the Link button's padding or font would
      // otherwise leave that sentence quietly false.
      expect(doneCard.hasStar).toBe(false);
      expect(doneCard.workOn).toBe(doneCard.link);
      expect(doneCard.headRow).toBe(doneCard.link);
    } finally {
      await booted.cleanup();
    }
  });

  test('Console keeps its crisper panel corner', async () => {
    test.setTimeout(90_000);
    const booted = await boot('console');
    const page = booted.window;
    try {
      await page.waitForSelector('.projects-stack .row', { timeout: 30_000 });
      const radii = await page.evaluate(() => {
        const panel = document.querySelector('.projects-stack > .group-block[data-status="now"]')!;
        return {
          panel: getComputedStyle(panel).borderTopLeftRadius,
          token: getComputedStyle(document.documentElement).getPropertyValue('--radius-lg').trim(),
          md: getComputedStyle(document.documentElement).getPropertyValue('--radius-md').trim(),
        };
      });
      // The panel reads `--radius-lg`, not a literal, which is the whole reason
      // Console's "a TUI draws boxes, not pills" override reaches it. Compared
      // against the live token, and against `--radius-md` to prove the panel is
      // on the larger of the two rather than having fallen back to `--radius`.
      expect(radii.panel).toBe(radii.token);
      expect(radii.panel).not.toBe(radii.md);
    } finally {
      await booted.cleanup();
    }
  });
});
