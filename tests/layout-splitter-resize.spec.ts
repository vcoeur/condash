/**
 * The Projects ↔ working-surface splitter survives a window resize.
 *
 * Regression guard: the splitter position used to persist as an absolute pixel
 * width (`layout.projectsWidth`), so narrowing the window left the Projects
 * pane at its stored size and pushed the splitter — and the entire working
 * surface — off the right edge, where it could not be dragged back. It is now a
 * fraction of the band (`layout.projectsSplit`) rendered through a clamped
 * percentage, so the split stays proportional and the handle stays reachable.
 */

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp, type BootedApp } from './fixtures/electron-app';

/** Left edge and width of the splitter, in viewport coordinates. */
async function splitterBox(booted: BootedApp): Promise<{ x: number; width: number }> {
  const box = await booted.window.locator('.top-band-splitter').boundingBox();
  if (!box) throw new Error('splitter has no bounding box — is the band in split mode?');
  return { x: box.x, width: box.width };
}

async function bandBox(booted: BootedApp): Promise<{ x: number; width: number }> {
  const box = await booted.window.locator('.top-band').boundingBox();
  if (!box) throw new Error('top band has no bounding box');
  return { x: box.x, width: box.width };
}

/**
 * Where the handle sits *within the band*, 0–1.
 *
 * Must subtract the band's own left edge: the splitter's `x` is viewport-
 * absolute, so dividing it by the band width folds in ~73px of fixed left chrome
 * (activity rail + workspace padding). That offset does not scale with the
 * viewport, so it lands differently at each width — it showed up as a ~0.047
 * drift on a splitter that was in fact exactly proportional, consuming almost
 * the whole tolerance below and leaving the assertion unable to see real drift.
 */
async function splitFraction(booted: BootedApp): Promise<number> {
  const [splitter, band] = await Promise.all([splitterBox(booted), bandBox(booted)]);
  return (splitter.x - band.x) / band.width;
}

test('the splitter stays proportional and on screen across a window resize', async () => {
  test.setTimeout(90_000);
  const booted = await bootApp({
    extraConfig: {},
    globalConfig: {
      layout: {
        projects: true,
        leftView: 'projects',
        working: 'code',
        terminal: false,
        projectsSplit: 0.5,
      },
    },
  });
  try {
    const page = booted.window;
    await page.locator('.top-band-splitter').waitFor({ state: 'visible', timeout: 15_000 });

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(300);
    const wide = await splitterBox(booted);
    const wideFraction = await splitFraction(booted);
    // Seeded at 0.5, so the handle sits at the middle of the band. Tight bounds:
    // with the coordinate basis correct this should be 0.5 within rounding, and
    // a loose window here is what let the old assertion pass on a wrong metric.
    expect(wideFraction).toBeGreaterThan(0.48);
    expect(wideFraction).toBeLessThan(0.52);

    // Narrow hard — this is the case that used to strand the splitter.
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForTimeout(300);
    const narrow = await splitterBox(booted);
    const narrowFraction = await splitFraction(booted);

    // Proportional: the handle holds the same relative position. Two decimal
    // places — the fraction is exact by construction, so the only slack needed
    // is sub-pixel rounding.
    expect(narrowFraction).toBeCloseTo(wideFraction, 2);
    // …and therefore actually moved left in absolute terms.
    expect(narrow.x).toBeLessThan(wide.x);

    // Reachable: fully inside the viewport, with room to grab it.
    expect(narrow.x).toBeGreaterThan(0);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(800);

    // The working surface keeps a usable width rather than collapsing.
    const codePane = await page.locator('.top-band > *').last().boundingBox();
    expect(codePane?.width ?? 0).toBeGreaterThan(100);
  } finally {
    await booted.cleanup();
  }
});

test('a drag on a band too narrow for both minimums leaves the stored split alone', async () => {
  // Regression guard, both directions. Below 2*MIN_PANE_PX + SPLITTER_PX the px
  // clamp pins the rendered width to MIN_PANE_PX for every pointer position, so
  // the pane does not move and the gesture expresses nothing. Deriving a
  // fraction from it is wrong whichever value you pick: from the clamped width,
  // a leftward drag stored 200/350 = 57%; from the raw pointer, a rightward
  // drag stored ~0.93, which on re-maximising squeezes the working surface to
  // its 200px minimum. The stored preference must simply survive.
  test.setTimeout(90_000);
  const booted = await bootApp({
    extraConfig: {},
    globalConfig: {
      layout: {
        projects: true,
        leftView: 'projects',
        working: 'code',
        terminal: false,
        projectsSplit: 0.5,
      },
    },
  });
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  try {
    const page = booted.window;
    await page.locator('.top-band-splitter').waitFor({ state: 'visible', timeout: 15_000 });
    // Band lands near 350px — narrower than the 404px both minimums need.
    await page.setViewportSize({ width: 440, height: 800 });
    await page.waitForTimeout(300);

    const band = await bandBox(booted);
    expect(band.width).toBeLessThan(2 * 200 + 4);

    const storedSplit = async (): Promise<number | undefined> =>
      JSON.parse(await readFile(globalPath, 'utf8')).layout?.projectsSplit;

    const dragTo = async (targetX: number): Promise<void> => {
      const handle = await splitterBox(booted);
      await page.mouse.move(handle.x + handle.width / 2, 400);
      await page.mouse.down();
      await page.mouse.move(targetX, 400, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(400);
    };

    // Hard left — "make Projects small". Used to store 0.571.
    await dragTo(band.x + 20);
    expect(await storedSplit()).toBe(0.5);

    // Hard right — "make Projects big". Used to store ~0.93, which collapses
    // the working surface once the window is widened again.
    await dragTo(band.x + band.width - 20);
    expect(await storedSplit()).toBe(0.5);
  } finally {
    await booted.cleanup();
  }
});

test('a drag released before the next frame still commits where it ended', async () => {
  // Regression guard: `onMove` only records the pointer and schedules `flush`,
  // and the committed fraction moves only inside `flush`. `onUp` used to cancel
  // the queued frame outright, so a nudge that started and finished inside one
  // ~16ms frame — an ordinary small adjustment — never flushed: the handle
  // snapped back and nothing was persisted. `mouse.move` with no `steps`
  // dispatches a single event, which is the tightest version of that race.
  test.setTimeout(90_000);
  const booted = await bootApp({
    extraConfig: {},
    globalConfig: {
      layout: {
        projects: true,
        leftView: 'projects',
        working: 'code',
        terminal: false,
        projectsSplit: 0.5,
      },
    },
  });
  const globalPath = join(booted.userDataDir, 'condash', 'settings.json');
  try {
    const page = booted.window;
    await page.locator('.top-band-splitter').waitFor({ state: 'visible', timeout: 15_000 });
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(300);

    // Dispatched synchronously inside one task, so no animation frame can run
    // between the move and the release. Playwright's own mouse API cannot
    // express this — each action is a separate round-trip, which always leaves
    // room for a frame, so a test driven through it passes even with the bug.
    await page.evaluate(() => {
      const handle = document.querySelector('.top-band-splitter');
      const band = document.querySelector('.top-band');
      if (!handle || !band) throw new Error('splitter or band missing');
      const bandRect = band.getBoundingClientRect();
      const handleRect = handle.getBoundingClientRect();
      const target = bandRect.left + bandRect.width * 0.25;
      handle.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          clientX: handleRect.left + handleRect.width / 2,
          clientY: 400,
        }),
      );
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: target, clientY: 400 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: target, clientY: 400 }));
    });

    await expect
      .poll(async () => JSON.parse(await readFile(globalPath, 'utf8')).layout?.projectsSplit)
      .toBeLessThan(0.4);
  } finally {
    await booted.cleanup();
  }
});

test('a very narrow window still leaves the splitter grabbable', async () => {
  test.setTimeout(90_000);
  const booted = await bootApp({
    extraConfig: {},
    globalConfig: {
      layout: {
        projects: true,
        leftView: 'projects',
        working: 'code',
        terminal: false,
        // Far right: the worst case for a stranded handle.
        projectsSplit: 0.9,
      },
    },
  });
  try {
    const page = booted.window;
    await page.locator('.top-band-splitter').waitFor({ state: 'visible', timeout: 15_000 });
    await page.setViewportSize({ width: 620, height: 800 });
    await page.waitForTimeout(300);

    const box = await splitterBox(booted);
    expect(box.x).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(620);
    // The clamp caps the Projects column at `100% - 204px`, so the handle can
    // never crowd the right edge no matter how extreme the stored fraction.
    expect(620 - (box.x + box.width)).toBeGreaterThan(150);
  } finally {
    await booted.cleanup();
  }
});
