import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Regression for 2026-08-19-md-preview-code-softwrap: verbatim text in the note
 * modal soft-wraps instead of pushing its long lines off the pane edge behind a
 * horizontal scrollbar. Both `.md-rendered` shapes are pinned — the fenced
 * block of a rendered note, and the read view of a source file.
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

test('note modal soft-wraps verbatim text: fenced code and source read view', async () => {
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

    // Source read view of a non-markdown file: same treatment, same rule.
    await window
      .locator('.resources-card', { hasText: 'long-line.css' })
      .locator('.resources-card-body')
      .click();
    await expect(window.locator('.note-modal .raw-code .hljs')).toBeVisible();
    const source = await preOverflow(window);
    expect(source.whiteSpace).toBe('pre-wrap');
    expect(source.scrollWidth).toBeLessThanOrEqual(source.clientWidth + 1);
    await window
      .screenshot({ path: join(SHOTS, 'source-view-wrapped.png') })
      .catch(() => undefined);
  } finally {
    await cleanup();
  }
});
