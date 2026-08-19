import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * Regression for 2026-08-19-md-preview-code-softwrap: rendered markdown never
 * scrolls sideways. Four surfaces are pinned — a fenced block, prose (which
 * covers the inherited `overflow-wrap` on paragraphs, list items and inline
 * `code`), a table, and the source read view of a non-markdown file — plus the
 * Help modal, which renders the bundled docs through the same pipeline.
 *
 * Every declaration has a fixture that fails without it: `white-space:
 * pre-wrap` needs a long line with spaces to break at, `overflow-wrap:
 * break-word` a single token with none, and the table bound (`display: block;
 * width: max-content; max-width: 100%; overflow-x: auto`) a long token inside
 * a cell — `break-word` does not shrink min-content, which is what an
 * auto-layout table sizes its columns from, so the table is the one element
 * here that gets a scroll box of its own rather than a wrap.
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
 * plus the distinct computed `white-space` / `overflow-x` values among them.
 * Measuring all matches rather than the first keeps a second fence in the
 * same document from slipping through.
 */
async function overflowOf(window: Page, selector: string) {
  return window.locator(selector).evaluateAll((elements) => ({
    count: elements.length,
    maxOverflow: Math.max(0, ...elements.map((el) => el.scrollWidth - el.clientWidth)),
    whiteSpace: [...new Set(elements.map((el) => getComputedStyle(el).whiteSpace))],
    overflowX: [...new Set(elements.map((el) => getComputedStyle(el).overflowX))],
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
        `# Long fence\n\nBefore.\n\n\`\`\`markdown\n${LONG_FENCE_LINE}\n\`\`\`\n\nA paragraph with an unbreakable token ${UNBREAKABLE} and an inline span \`${UNBREAKABLE}\`.\n\n\`\`\`text\n${UNBREAKABLE}\n\`\`\`\n\n| Key | Value |\n|---|---|\n| token | ${UNBREAKABLE} |\n\nAfter.\n`,
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
    // …and neither does the article around it, nor the modal body: prose and
    // the inline span break, and the table — whose cell holds the same token,
    // and which sizes its columns from a min-content pass `break-word` does
    // not affect — is bounded so it scrolls inside itself instead of dragging
    // the article wider. That last one is why the fixture has a table at all.
    expectNoOverflow(await overflowOf(window, '.note-modal .md-rendered'));
    expectNoOverflow(await overflowOf(window, '.note-modal .modal-body'));
    // Both halves of the table bound, or the cell content becomes unreachable
    // rather than scrollable: it does overflow, and it can be scrolled.
    const table = await overflowOf(window, '.note-modal .md-rendered table');
    expect(table.count).toBe(1);
    expect(table.maxOverflow).toBeGreaterThan(0);
    expect(table.overflowX).toEqual(['auto']);
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
    // One `<pre class="hljs">` for the whole file — pinned so a future
    // line-gutter or degrade path can't leave this measuring a fragment.
    expect(source.count).toBe(1);
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
    // The Help body carries `.md-rendered`, so it inherits the note contract
    // rather than a second copy of it.
    await expect(window.locator('.help-modal .md-rendered pre').first()).toBeVisible();

    // Nothing in the bundled `cli.md` is long enough to overflow this panel,
    // so measuring it as shipped would pass with or without the fix. Inject
    // a token that cannot fit and measure that instead — the docs come out of
    // the asar, so injection is the only way this test controls its fixture.
    await window.evaluate((token) => {
      const body = document.querySelector('.help-modal .md-rendered');
      if (!body) throw new Error('help body missing');
      const block = document.createElement('pre');
      block.textContent = token;
      body.appendChild(block);
    }, UNBREAKABLE);

    const fence = await overflowOf(window, '.help-modal .md-rendered pre');
    // Two shipped fences plus the injected one. Pinned because the body's
    // innerHTML is a reactive binding: if the injected node is ever dropped,
    // the shipped two overflow by nothing and every assertion below would
    // pass on content that cannot fail.
    expect(fence.count).toBe(3);
    expect(fence.whiteSpace).toEqual(['pre-wrap']);
    expectNoOverflow(fence);
    expectNoOverflow(await overflowOf(window, '.help-modal .md-rendered'));
    await mkdir(SHOTS, { recursive: true }).catch(() => undefined);
    await window.screenshot({ path: join(SHOTS, 'help-cli-wrapped.png') }).catch(() => undefined);
    await window.keyboard.press('Escape');
    await expect(window.locator('.help-modal')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
