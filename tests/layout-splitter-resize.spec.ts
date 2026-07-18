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
import { bootApp, type BootedApp } from './fixtures/electron-app';

/** Left edge and width of the splitter, in viewport coordinates. */
async function splitterBox(booted: BootedApp): Promise<{ x: number; width: number }> {
  const box = await booted.window.locator('.top-band-splitter').boundingBox();
  if (!box) throw new Error('splitter has no bounding box — is the band in split mode?');
  return { x: box.x, width: box.width };
}

async function bandWidth(booted: BootedApp): Promise<number> {
  const box = await booted.window.locator('.top-band').boundingBox();
  if (!box) throw new Error('top band has no bounding box');
  return box.width;
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
    const wideBand = await bandWidth(booted);
    // Seeded at 0.5, so the handle sits near the middle of the band.
    expect(wide.x / wideBand).toBeGreaterThan(0.4);
    expect(wide.x / wideBand).toBeLessThan(0.6);

    // Narrow hard — this is the case that used to strand the splitter.
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForTimeout(300);
    const narrow = await splitterBox(booted);
    const narrowBand = await bandWidth(booted);

    // Proportional: the handle holds roughly the same relative position…
    expect(narrow.x / narrowBand).toBeCloseTo(wide.x / wideBand, 1);
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
