import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * End-to-end export pipeline for visual notes: open an `.mdx` in the MDX
 * viewer, click "Export as PDF", and assert a real PDF lands at the picked
 * path. The OS save dialog is stubbed in the main process; the rest — the
 * serialised `.plan-doc` with its inline stylesheets, the hidden print
 * window, `printToPDF`, the file write — runs for real. Also pins the width
 * rule: top-level blocks fill the document like a classic note, no measure.
 */

const PLAN_MDX = `---
title: Export me
kind: plan
---

## Goal

Some prose that used to sit on an 860px measure.

<Table columns={["a", "b"]} rows={[["1", "2"]]} />

<Callout tone="info" body={"A callout."} />

<Mermaid source={"graph LR; A-->B"} caption="A tiny graph" />

<QuestionForm id="oq" questions={[{ id: "q1", title: "Pick one", mode: "single", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }] }]} />
`;

test('Export as PDF prints the open visual note, and blocks fill the document width', async () => {
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      const res = join(conceptionDir, 'resources');
      await mkdir(res, { recursive: true });
      await writeFile(join(res, 'export-me.mdx'), PLAN_MDX, 'utf8');
    },
  });
  try {
    const win = booted.window;
    const target = join(booted.conceptionDir, 'exported-visual.pdf');
    await booted.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, target);

    await win.setViewportSize({ width: 1400, height: 900 });
    await win.locator('.rail-item[title*="Resources"]').click();
    await win
      .locator('.resources-card', { hasText: 'export-me.mdx' })
      .locator('.resources-card-body')
      .click();
    await expect(win.locator('.mdx-modal')).toBeVisible();
    await expect(win.locator('.mdx-modal .plan-table')).toBeVisible();

    // Width: a prose block and a table block both span the document — the
    // same rule the classic note viewer applies, no centred measure.
    const widths = await win.evaluate(() => {
      const doc = document.querySelector('.mdx-modal .plan-doc') as HTMLElement;
      const prose = doc.querySelector(':scope > .plan-prose') as HTMLElement;
      const table = doc.querySelector(':scope > .plan-table') as HTMLElement;
      const inner = doc.clientWidth - 48; // 24px padding each side
      return {
        inner,
        prose: prose.getBoundingClientRect().width,
        table: table.getBoundingClientRect().width,
        proseMax: getComputedStyle(prose).maxWidth,
        proseLeft: prose.getBoundingClientRect().left - doc.getBoundingClientRect().left,
      };
    });
    expect(widths.proseMax).toBe('none');
    expect(Math.abs(widths.prose - widths.inner)).toBeLessThan(2);
    expect(Math.abs(widths.table - widths.inner)).toBeLessThan(2);
    expect(Math.abs(widths.proseLeft - 24)).toBeLessThan(2);

    // Tick an answer first: the PDF freezes the live form state.
    await win.locator('.mdx-modal .plan-option', { hasText: 'Option B' }).locator('input').check();

    await win.click('.mdx-modal button[aria-label="Export as PDF"]');
    await win.waitForSelector('.mdx-modal .modal-saved[title="PDF exported"]', {
      timeout: 20000,
    });

    const pdf = await readFile(target);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
  } finally {
    await booted.cleanup();
  }
});

test('the export button is absent in source mode', async () => {
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      const res = join(conceptionDir, 'resources');
      await mkdir(res, { recursive: true });
      await writeFile(join(res, 'export-me.mdx'), PLAN_MDX, 'utf8');
    },
  });
  try {
    const win = booted.window;
    await win.locator('.rail-item[title*="Resources"]').click();
    await win
      .locator('.resources-card', { hasText: 'export-me.mdx' })
      .locator('.resources-card-body')
      .click();
    await expect(win.locator('.mdx-modal')).toBeVisible();
    await expect(win.locator('.mdx-modal button[aria-label="Export as PDF"]')).toBeVisible();
    await win.locator('.mdx-modal .modal-seg .btn', { hasText: 'Source' }).click();
    await expect(win.locator('.mdx-modal button[aria-label="Export as PDF"]')).toHaveCount(0);
  } finally {
    await booted.cleanup();
  }
});
