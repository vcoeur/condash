import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * End-to-end for the in-app file viewers + reveal affordance added by
 * 2026-05-31-condash-file-preview-and-reveal. Boots a fixture conception whose
 * `resources/` holds an image, a CSS file, and an HTML file, then drives the
 * Resources pane to confirm each opens in the right in-app viewer (and that the
 * reveal button is wired). Screenshots of each viewer are captured for the PR.
 */

// 1×1 transparent PNG — the smallest valid raster the image viewer can load.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const SHOTS = resolve(__dirname, 'screenshots-out', 'file-preview');

test('Resources viewers: image, highlighted code, HTML rendered/source, reveal', async () => {
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      const res = join(conceptionDir, 'resources');
      await mkdir(res, { recursive: true });
      await writeFile(join(res, 'pixel.png'), PNG_1x1);
      await writeFile(
        join(res, 'styles.css'),
        '.card {\n  color: #1a1a1a;\n  margin: 0 auto;\n  padding: 12px;\n}\n',
        'utf8',
      );
      await writeFile(
        join(res, 'page.html'),
        '<!doctype html>\n<html>\n<body>\n<h1>Hello</h1>\n<p>Rendered by condash.</p>\n</body>\n</html>\n',
        'utf8',
      );
    },
  });
  const { window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1280, height: 900 });
    const resourcesHandle = window
      .locator('.edge-strip-right .edge-handle')
      .filter({ hasText: 'Resources' });
    await resourcesHandle.click();
    await expect(window.locator('.resources-pane')).toBeVisible();

    // Every card carries the reveal affordance.
    const cssCard = window.locator('.resources-card', { hasText: 'styles.css' });
    await expect(cssCard.locator('.resources-card-action', { hasText: 'reveal' })).toBeVisible();

    // CSS → note modal, read-only, syntax-highlighted.
    await cssCard.locator('.resources-card-body').click();
    await expect(window.locator('.note-modal')).toBeVisible();
    await expect(window.locator('.note-modal .raw-code .hljs')).toBeVisible();
    await mkdir(SHOTS, { recursive: true }).catch(() => undefined);
    await window.screenshot({ path: join(SHOTS, 'code-highlight.png') }).catch(() => undefined);
    await window.keyboard.press('Escape');
    await expect(window.locator('.note-modal')).toHaveCount(0);

    // Image → image modal with a live <img>.
    await window
      .locator('.resources-card', { hasText: 'pixel.png' })
      .locator('.resources-card-body')
      .click();
    await expect(window.locator('.image-modal')).toBeVisible();
    await expect(window.locator('.image-modal .image-view')).toBeVisible();
    await window.screenshot({ path: join(SHOTS, 'image-modal.png') }).catch(() => undefined);
    await window.keyboard.press('Escape');
    await expect(window.locator('.image-modal')).toHaveCount(0);

    // HTML → rendered webview by default, with a Rendered/Source toggle.
    await window
      .locator('.resources-card', { hasText: 'page.html' })
      .locator('.resources-card-body')
      .click();
    await expect(window.locator('.html-modal')).toBeVisible();
    await expect(window.locator('.html-modal .html-webview')).toBeVisible();
    // Flip to Source → highlighted markup.
    await window.locator('.html-modal .modal-seg .btn', { hasText: 'Source' }).click();
    await expect(window.locator('.html-modal .html-source .hljs')).toBeVisible();
    await window.screenshot({ path: join(SHOTS, 'html-source.png') }).catch(() => undefined);
    await window.keyboard.press('Escape');
    await expect(window.locator('.html-modal')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
