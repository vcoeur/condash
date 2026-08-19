import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Regression for 2026-08-19-md-preview-code-softwrap: rendered markdown never
 * scrolls sideways. Four surfaces are pinned — a fenced block, prose (which
 * covers the inherited `overflow-wrap` on paragraphs, list items and inline
 * `code`), the source read view of a non-markdown file, and the Help modal,
 * which renders through the same pipeline into `.markdown-body` and so needs
 * its own rule.
 *
 * Both halves of the CSS matter and each has its own fixture: `white-space:
 * pre-wrap` handles a long line that has spaces to break at, `overflow-wrap:
 * break-word` handles a single token with none.
 */

const SHOTS = resolve(__dirname, 'screenshots-out', 'md-preview-softwrap');

const LONG_FENCE_LINE =
  '- **Claude models shorten by thirty percent and remove generic commentary.** Applies when the system prompt names your model as a Claude model (Opus, Fable, Sonnet, Haiku) — not to other models launched through the same harness.';

/** No spaces anywhere: only `overflow-wrap` can break this one. */
const UNBREAKABLE = 'x'.repeat(400);

const LONG_CSS_LINE =
  '.some-very-long-selector .nested-child .deeper-descendant .and-one-more-level .plus-a-modifier-class { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.25), inset 0 0 0 1px rgba(255, 255, 255, 0.08), 0 24px 64px rgba(0, 0, 0, 0.5); transition: box-shadow 120ms ease-in-out, background-color 120ms ease-in-out, border-color 120ms ease-in-out; }';

/**
 * Worst horizontal overflow across *every* element matching the selector,
 * plus the distinct computed `white-space` values among them. Measuring all
 * matches rather than the first keeps a second fence in the same document
 * from slipping through.
 */
async function overflowOf(window: Page, selector: string) {
  return window.locator(selector).evaluateAll((elements) => ({
    count: elements.length,
    maxOverflow: Math.max(0, ...elements.map((el) => el.scrollWidth - el.clientWidth)),
    whiteSpace: [...new Set(elements.map((el) => getComputedStyle(el).whiteSpace))],
  }));
}

/** Assert every matched element has nothing to scroll horizontally. */
function expectNoOverflow(box: { count: number; maxOverflow: number }) {
  expect(box.count).toBeGreaterThan(0);
  expect(box.maxOverflow).toBeLessThanOrEqual(1);
}

test('note modal soft-wraps verbatim text: fenced code, prose, source read view', async () => {
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      const res = join(conceptionDir, 'resources');
      await mkdir(res, { recursive: true });
      await writeFile(
        join(res, 'long-fence.md'),
        `# Long fence\n\nBefore.\n\n\`\`\`markdown\n${LONG_FENCE_LINE}\n\`\`\`\n\nA paragraph with an unbreakable token ${UNBREAKABLE} and an inline span \`${UNBREAKABLE}\`.\n\n\`\`\`text\n${UNBREAKABLE}\n\`\`\`\n\nAfter.\n`,
        'utf8',
      );
      await writeFile(
        join(res, 'long-line.css'),
        `${LONG_CSS_LINE}\n/* ${UNBREAKABLE} */\n`,
        'utf8',
      );
    },
  });
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1280, height: 900 });
    await window.locator('.rail-item[title*="Resources"]').click();
    await expect(window.locator('.resources-pane')).toBeVisible();

    // Rendered markdown: the fence wraps, so the block has nothing to scroll…
    await window
      .locator('.resources-card', { hasText: 'long-fence.md' })
      .locator('.resources-card-body')
      .click();
    await expect(window.locator('.note-modal .md-rendered pre').first()).toBeVisible();
    // Two fences: one that can break at spaces, one 400-char token that can't.
    const fence = await overflowOf(window, '.note-modal .md-rendered pre');
    expect(fence.count).toBe(2);
    expect(fence.whiteSpace).toEqual(['pre-wrap']);
    expectNoOverflow(fence);
    // …and neither does the article around it, nor the modal body: prose, the
    // inline span and the space-free fence all break rather than widen it.
    expectNoOverflow(await overflowOf(window, '.note-modal .md-rendered'));
    expectNoOverflow(await overflowOf(window, '.note-modal .modal-body'));
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
    const source = await overflowOf(window, '.note-modal .md-rendered pre');
    expect(source.whiteSpace).toEqual(['pre-wrap']);
    expectNoOverflow(source);
    await window
      .screenshot({ path: join(SHOTS, 'source-view-wrapped.png') })
      .catch(() => undefined);
    await window.keyboard.press('Escape');
    await expect(window.locator('.note-modal')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test('the Help modal wraps its bundled docs too', async () => {
  const booted = await bootApp();
  const { app, window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1280, height: 900 });
    // Help opens from the native menu; specs drive it over the same channel.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu-command', 'help-cli');
    });
    // `docs/help/cli.md` is mostly long `condash …` invocations in fences.
    await expect(window.locator('.help-modal .markdown-body pre').first()).toBeVisible();
    const fence = await overflowOf(window, '.help-modal .markdown-body pre');
    expect(fence.whiteSpace).toEqual(['pre-wrap']);
    expectNoOverflow(fence);
    expectNoOverflow(await overflowOf(window, '.help-modal .markdown-body'));
    await mkdir(SHOTS, { recursive: true }).catch(() => undefined);
    await window.screenshot({ path: join(SHOTS, 'help-cli-wrapped.png') }).catch(() => undefined);
  } finally {
    await cleanup();
  }
});
