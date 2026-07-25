import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

const samplePath = (conceptionDir: string) =>
  join(conceptionDir, 'projects', '2026-04', '2026-04-26-sample', 'README.md');

test('status drag rewrites the README on disk', async () => {
  const booted = await bootApp();
  try {
    // The renderer's setStatus + watcher round-trip is what we care about
    // here; exercise the IPC path directly without the pointer gesture.
    const path = samplePath(booted.conceptionDir);
    await booted.window.evaluate(({ p }) => window.condash.setStatus(p, 'done'), { p: path });
    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toContain('**Status**: done');
  } finally {
    await booted.cleanup();
  }
});

test('pointer-drag a card onto another lane changes its status', async () => {
  const booted = await bootApp();
  try {
    const { window } = booted;
    const card = window.locator('article.row').first();
    await expect(card).toHaveAttribute('data-status-card', 'now');

    // Drive a real pointer gesture (down → past the drag threshold → over the
    // target lane → up). HTML5 drag-and-drop is broken under Wayland Ozone, so
    // the drag is built on pointer events — this test exercises that path.
    const box = await card.boundingBox();
    if (!box) throw new Error('card has no bounding box');
    const startX = box.x + box.width / 2;
    const startY = box.y + 16;
    await window.mouse.move(startX, startY);
    await window.mouse.down();
    // Cross the 4px threshold so the drag begins and empty lanes inflate.
    await window.mouse.move(startX, startY + 14, { steps: 3 });

    // The ghost is a body-appended clone of the card. It must follow the
    // pointer: `.row` carries a filled `fade-up` entrance animation, and a CSS
    // animation outranks the style attribute — so an un-cancelled one pinned
    // the ghost opaque at the viewport origin for the whole gesture.
    const ghost = window.locator('body > article.row[aria-hidden="true"]');
    await expect(ghost).toHaveCount(1);
    const firstGhostBox = await ghost.boundingBox();
    if (!firstGhostBox) throw new Error('ghost has no bounding box');
    expect(firstGhostBox.y).toBeGreaterThan(0);
    await expect
      .poll(async () => await ghost.evaluate((el) => getComputedStyle(el).opacity))
      .toBe('0.55');

    const lane = window.locator('.group-block[data-status="review"]');
    const laneBox = await lane.boundingBox();
    if (!laneBox) throw new Error('review lane has no bounding box');
    const dropX = laneBox.x + laneBox.width / 2;
    const dropY = laneBox.y + laneBox.height / 2;
    await window.mouse.move(dropX, dropY, { steps: 8 });

    // Ghost travel matches pointer travel — the transform tracks the cursor.
    const movedGhostBox = await ghost.boundingBox();
    if (!movedGhostBox) throw new Error('moved ghost has no bounding box');
    expect(Math.abs(movedGhostBox.x - firstGhostBox.x - (dropX - startX))).toBeLessThan(2);
    expect(Math.abs(movedGhostBox.y - firstGhostBox.y - (dropY - (startY + 14)))).toBeLessThan(2);

    await window.mouse.up();
    await expect(ghost).toHaveCount(0);

    // Optimistic UI moves the card immediately; the README rewrite is the
    // durable proof the drop committed.
    await expect(card).toHaveAttribute('data-status-card', 'review');
    await expect
      .poll(async () => await readFile(samplePath(booted.conceptionDir), 'utf8'))
      .toContain('**Status**: review');
  } finally {
    await booted.cleanup();
  }
});
