import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * End-to-end for the visual-note MDX viewer: a `.mdx` file opens in the
 * MdxModal (not the OS fallback), typed blocks render natively, validation
 * issues surface in the banner, answers given across *several* question-forms
 * are written back into the file by one Ctrl+S, closing with unsaved answers
 * is gated, and the Source toggle shows highlighted MDX.
 */

const PLAN_MDX = `---
title: Demo review
kind: review
---

## Outcome

The demo change landed.

<Callout id="c1" tone="decision">

Chosen: **option A**.

</Callout>

<Diff id="d1" filename="src/a.ts" language="ts" before={"const a = 1;\\n"} after={"const a = 2;\\n"} annotations={[{ lines: "1", note: "bumped" }]} />

<WireframeBlock id="wf1">
  <Screen surface="popover" html={"<div style=\\"display:flex;flex-direction:column;gap:8px;padding:16px\\"><h3>Menu</h3><span class=\\"wf-pill accent\\">New</span><button class=\\"primary\\">Save</button></div>"} caption="The popover" />
</WireframeBlock>

<QuestionForm id="oq" questions={[{ id: "q1", title: "Pick one", mode: "single", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }] }]} submitLabel="Save answers" />

## Follow-up

<QuestionForm questions={[{ id: "q2", title: "Anything else", mode: "freeform" }]} />

<Bogus id="nope" />
`;

const SHOTS = resolve(__dirname, 'screenshots-out', 'mdx-viewer');

test('MDX plan opens in the block viewer with issues banner and source toggle', async () => {
  let conceptionPath = '';
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      conceptionPath = conceptionDir;
      const res = join(conceptionDir, 'resources');
      await mkdir(res, { recursive: true });
      await writeFile(join(res, 'demo-plan.mdx'), PLAN_MDX, 'utf8');
    },
  });
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1280, height: 900 });
    await window.locator('.rail-item[title*="Resources"]').click();
    await expect(window.locator('.resources-pane')).toBeVisible();

    await window
      .locator('.resources-card', { hasText: 'demo-plan.mdx' })
      .locator('.resources-card-body')
      .click();
    await expect(window.locator('.mdx-modal')).toBeVisible();
    await expect(window.locator('.mdx-modal .plan-kind-pill')).toHaveText('review');

    // Typed blocks render natively.
    await expect(window.locator('.mdx-modal .plan-callout')).toBeVisible();
    await expect(window.locator('.mdx-modal .plan-diff')).toBeVisible();
    await expect(window.locator('.mdx-modal .wf-frame')).toBeVisible();
    await expect(window.locator('.mdx-modal .wf-screen button.primary')).toHaveText('Save');

    // The unknown tag salvages to a placeholder + issues banner, rest renders.
    await expect(window.locator('.mdx-modal .plan-invalid')).toBeVisible();
    const issuesHead = window.locator('.mdx-modal .plan-issues-head');
    await expect(issuesHead).toContainText('error');
    await issuesHead.click();
    await expect(window.locator('.mdx-modal .plan-issues li').first()).toContainText('Bogus');

    // Interactive question-forms: answer in BOTH forms, then save once. The
    // head Save button is the only save control, and it stays disabled until
    // an answer is actually pending.
    const saveButton = window.locator('.mdx-modal [aria-label="Save answers"]');
    await expect(window.locator('.mdx-modal .plan-answer-save')).toHaveCount(0);
    await expect(saveButton).toBeDisabled();

    const optionB = window
      .locator('.mdx-modal .plan-option', { hasText: 'Option B' })
      .locator('input');
    await optionB.check();
    await window.locator('.mdx-modal .plan-answer-text').fill('one more thing');
    await expect(saveButton).toBeEnabled();
    await expect(window.locator('.mdx-modal .modal-dirty')).toBeVisible();

    // Ctrl+S writes every pending form in one pass — pre-fix, the second
    // form's answer was dropped on the floor.
    await window.keyboard.press('Control+s');
    const mdxPath = join(conceptionPath, 'resources', 'demo-plan.mdx');
    await expect.poll(() => readFile(mdxPath, 'utf8')).toContain('answer: "b"');
    await expect.poll(() => readFile(mdxPath, 'utf8')).toContain('answer: "one more thing"');
    await expect(optionB).toBeChecked();
    await expect(window.locator('.mdx-modal .plan-answer-text')).toHaveValue('one more thing');
    await expect(saveButton).toBeDisabled();
    await expect(window.locator('.mdx-modal .modal-dirty')).toHaveCount(0);

    await mkdir(SHOTS, { recursive: true }).catch(() => undefined);
    await window.screenshot({ path: join(SHOTS, 'mdx-rendered.png') }).catch(() => undefined);

    // Source toggle → highlighted MDX.
    await window.locator('.mdx-modal .modal-seg .btn', { hasText: 'Source' }).click();
    await expect(window.locator('.mdx-modal .mdx-source .hljs')).toBeVisible();
    await window.locator('.mdx-modal .modal-seg .btn', { hasText: 'Rendered' }).click();

    // Closing with unsaved answers is gated rather than silently discarding.
    await window.locator('.mdx-modal .plan-answer-text').fill('not saved yet');
    await window.keyboard.press('Escape');
    await expect(window.locator('.mdx-modal .modal-confirm')).toBeVisible();
    await window.locator('.mdx-modal .modal-confirm .btn', { hasText: 'Discard' }).click();
    await expect(window.locator('.mdx-modal')).toHaveCount(0);
    expect(await readFile(mdxPath, 'utf8')).toContain('answer: "one more thing"');
  } finally {
    await cleanup();
  }
});
