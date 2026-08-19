import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Regression for 2026-08-19-md-preview-code-softwrap: a fenced block in a
 * rendered note soft-wraps instead of pushing its long lines off the pane edge
 * behind a horizontal scrollbar. The source-file read view is the deliberate
 * exception — real source keeps `white-space: pre` so a wrapped line can't read
 * as an indent level — so both halves are pinned here.
 */

const SHOTS = resolve(__dirname, 'screenshots-out', 'md-preview-softwrap');

const LONG_FENCE_LINE =
  '- **Claude models shorten by thirty percent and remove generic commentary.** Applies when the system prompt names your model as a Claude model (Opus, Fable, Sonnet, Haiku) — not to other models launched through the same harness.';

const LONG_CSS_LINE =
  '.some-very-long-selector .nested-child .deeper-descendant .and-one-more-level .plus-a-modifier-class { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.25), inset 0 0 0 1px rgba(255, 255, 255, 0.08), 0 24px 64px rgba(0, 0, 0, 0.5); transition: box-shadow 120ms ease-in-out, background-color 120ms ease-in-out, border-color 120ms ease-in-out; }';

/** Horizontal overflow of the first `<pre>` in the open note modal. */
async function preOverflow(window: import('@playwright/test').Page) {
  return window
    .locator('.note-modal .md-rendered pre')
    .first()
    .evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      whiteSpace: getComputedStyle(el).whiteSpace,
    }));
}

test('note preview soft-wraps fenced code; source read view still scrolls', async () => {
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      const res = join(conceptionDir, 'resources');
      await mkdir(res, { recursive: true });
      await writeFile(
        join(res, 'long-fence.md'),
        `# Long fence\n\nBefore.\n\n\`\`\`markdown\n${LONG_FENCE_LINE}\n\`\`\`\n\nAfter.\n`,
        'utf8',
      );
      await writeFile(join(res, 'long-line.css'), `${LONG_CSS_LINE}\n`, 'utf8');
    },
  });
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1280, height: 900 });
    await window.locator('.rail-item[title*="Resources"]').click();
    await expect(window.locator('.resources-pane')).toBeVisible();

    // Rendered markdown: the fence wraps, so the block has nothing to scroll.
    await window
      .locator('.resources-card', { hasText: 'long-fence.md' })
      .locator('.resources-card-body')
      .click();
    await expect(window.locator('.note-modal .md-rendered pre')).toBeVisible();
    const fence = await preOverflow(window);
    expect(fence.whiteSpace).toBe('pre-wrap');
    expect(fence.scrollWidth).toBeLessThanOrEqual(fence.clientWidth + 1);
    await mkdir(SHOTS, { recursive: true }).catch(() => undefined);
    await window.screenshot({ path: join(SHOTS, 'note-fence-wrapped.png') }).catch(() => undefined);
    await window.keyboard.press('Escape');
    await expect(window.locator('.note-modal')).toHaveCount(0);

    // Source read view: alignment is load-bearing, so long lines still scroll.
    await window
      .locator('.resources-card', { hasText: 'long-line.css' })
      .locator('.resources-card-body')
      .click();
    await expect(window.locator('.note-modal .raw-code .hljs')).toBeVisible();
    const source = await preOverflow(window);
    expect(source.whiteSpace).toBe('pre');
    expect(source.scrollWidth).toBeGreaterThan(source.clientWidth);
  } finally {
    await cleanup();
  }
});
