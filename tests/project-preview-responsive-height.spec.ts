import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

const VIEWPORT = { width: 1280, height: 900 };
const TERMINAL_HEIGHT = 680;
const BACKDROP_PADDING = 24;

interface PreviewGeometry {
  paneHeight: number;
  terminalHeight: number;
  maxHeight: number;
  boxSizing: string;
  modal: { top: number; bottom: number; height: number };
  backdrop: { top: number; bottom: number };
  body: { clientHeight: number; scrollHeight: number };
}

/** Read the terminal publication and the preview's border-box geometry together. */
async function previewGeometry(page: Page): Promise<PreviewGeometry> {
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('.terminal-pane');
    const backdrop = document.querySelector<HTMLElement>('.modal-backdrop');
    const modal = document.querySelector<HTMLElement>('.modal.project-preview');
    const body = document.querySelector<HTMLElement>('.preview-body.revamped');
    if (!pane || !backdrop || !modal || !body) {
      throw new Error('terminal pane or project preview geometry is unavailable');
    }

    const paneRect = pane.getBoundingClientRect();
    const backdropRect = backdrop.getBoundingClientRect();
    const modalRect = modal.getBoundingClientRect();
    const modalStyle = getComputedStyle(modal);
    const rootStyle = getComputedStyle(document.documentElement);

    return {
      paneHeight: paneRect.height,
      terminalHeight: Number.parseFloat(rootStyle.getPropertyValue('--terminal-pane-height')),
      maxHeight: Number.parseFloat(modalStyle.maxHeight),
      boxSizing: modalStyle.boxSizing,
      modal: { top: modalRect.top, bottom: modalRect.bottom, height: modalRect.height },
      backdrop: { top: backdropRect.top, bottom: backdropRect.bottom },
      body: { clientHeight: body.clientHeight, scrollHeight: body.scrollHeight },
    };
  });
}

/** Assert the project modal occupies exactly the padded terminal-aware cap. */
function expectCappedPreview(geometry: PreviewGeometry, cap: number): void {
  expect(geometry.maxHeight).toBeCloseTo(cap, 0);
  expect(geometry.boxSizing).toBe('border-box');
  expect(geometry.modal.height).toBeCloseTo(cap, 0);
  expect(geometry.modal.top).toBeCloseTo(geometry.backdrop.top + BACKDROP_PADDING, 0);
  expect(geometry.modal.bottom).toBeCloseTo(geometry.backdrop.bottom - BACKDROP_PADDING, 0);
  expect(geometry.body.clientHeight).toBeGreaterThan(0);
  expect(geometry.body.scrollHeight).toBeGreaterThan(geometry.body.clientHeight);
}

/** Seed a long, parentless project whose preview body must scroll at the cap. */
async function prepareTallProject(conceptionDir: string): Promise<void> {
  const projectDir = join(conceptionDir, 'projects', '2026-09', '2026-09-12-tall-preview');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'README.md'),
    `---
date: 2026-09-12
kind: project
status: now
---

# Tall preview fixture

## Goal

This deliberately long parentless fixture keeps the project preview body taller than the extreme terminal-aware cap.

## Steps

${Array.from({ length: 12 }, (_, index) => `- [ ] Complete tall fixture step ${index + 1}`).join('\n')}

## Timeline

${Array.from(
  { length: 16 },
  (_, index) =>
    `- 2026-09-12 — Tall fixture activity entry ${index + 1} records scrollable preview content.`,
).join('\n')}

## Deliverables

${Array.from({ length: 8 }, (_, index) => `- Tall fixture deliverable ${index + 1}`).join('\n')}
`,
    'utf8',
  );
}

test('the wide project preview follows terminal ResizeObserver height and keeps its body scrollable', async () => {
  test.setTimeout(90_000);
  const booted = await bootApp({
    globalConfig: { layout: { terminal: true } },
    prepare: prepareTallProject,
  });
  try {
    const page = booted.window;
    await page.setViewportSize(VIEWPORT);
    await page.locator('.row .title-text', { hasText: 'Tall preview fixture' }).click();
    await expect(page.locator('.modal.project-preview')).toBeVisible();

    // Opening a preview auto-collapses the terminal. Reopen it through the real
    // global terminal toggle before dragging its actual resize handle.
    await page.keyboard.press('Control+`');
    await expect(page.locator('.terminal-pane-resize')).toBeVisible();

    const initial = await previewGeometry(page);
    const handle = await page.locator('.terminal-pane-resize').boundingBox();
    if (!handle) throw new Error('terminal resize handle has no bounding box');
    const dragX = handle.x + handle.width / 2;
    const startY = handle.y + handle.height / 2;
    const targetY = startY - (TERMINAL_HEIGHT - initial.paneHeight);
    await page.mouse.move(dragX, startY);
    await page.mouse.down();
    await page.mouse.move(dragX, targetY, { steps: 12 });
    await page.mouse.up();

    // The splitter gesture changes the pane border box; ResizeObserver publishes
    // that box into the CSS variable, which in turn changes the modal cap.
    await expect
      .poll(async () => (await previewGeometry(page)).terminalHeight)
      .toBeCloseTo(TERMINAL_HEIGHT, 0);
    await expect
      .poll(async () => (await previewGeometry(page)).paneHeight)
      .toBeCloseTo(TERMINAL_HEIGHT, 0);
    await expect
      .poll(async () => (await previewGeometry(page)).maxHeight)
      .toBeCloseTo(VIEWPORT.height - TERMINAL_HEIGHT - BACKDROP_PADDING * 2, 0);

    const afterDrag = await previewGeometry(page);
    expect(afterDrag.terminalHeight).not.toBeCloseTo(initial.terminalHeight, 0);
    expectCappedPreview(afterDrag, 172);

    // Changing only the viewport recomputes the 100vh term; it must not be
    // mistaken for a new terminal-height publication.
    await page.setViewportSize({ width: VIEWPORT.width, height: 960 });
    await expect.poll(async () => (await previewGeometry(page)).maxHeight).toBeCloseTo(232, 0);
    const afterViewportResize = await previewGeometry(page);
    expect(afterViewportResize.paneHeight).toBeCloseTo(TERMINAL_HEIGHT, 0);
    expect(afterViewportResize.terminalHeight).toBeCloseTo(TERMINAL_HEIGHT, 0);
    expectCappedPreview(afterViewportResize, 232);

    // Collapsing leaves the terminal's tab strip mounted. Its nonzero border box
    // remains the observer-published reservation used by the project preview.
    await page.keyboard.press('Control+`');
    await expect(page.locator('.terminal-pane')).toHaveClass(/closed/);
    await expect.poll(async () => (await previewGeometry(page)).terminalHeight).toBeGreaterThan(0);
    const collapsed = await previewGeometry(page);
    expect(collapsed.paneHeight).toBeGreaterThan(0);
    expect(collapsed.terminalHeight).toBeCloseTo(collapsed.paneHeight, 0);
    expect(collapsed.maxHeight).toBeCloseTo(
      Math.min(0.85 * 960, 900, 960 - collapsed.terminalHeight - BACKDROP_PADDING * 2),
      0,
    );
  } finally {
    await booted.cleanup();
  }
});
