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

test('dragging left on a band too narrow for both minimums still stores a narrow split', async () => {
  // Regression guard: below 2*MIN_PANE_PX + SPLITTER_PX the px clamp pins the
  // rendered width to MIN_PANE_PX for every pointer position. The commit used
  // to derive its fraction from that pinned width, so a drag hard LEFT to
  // shrink Projects persisted MIN_PANE_PX / band — a *larger* split than the
  // 0.5 it started from. Re-maximising then showed a pane roughly twice the
  // size the user had asked for. The fraction now comes from the pointer.
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

    const handle = await splitterBox(booted);
    await page.mouse.move(handle.x + handle.width / 2, 400);
    await page.mouse.down();
    // Drag hard left — unambiguously "make Projects small".
    await page.mouse.move(band.x + 20, 400, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(async () => JSON.parse(await readFile(globalPath, 'utf8')).layout?.projectsSplit)
      .toBeLessThan(0.3);
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
