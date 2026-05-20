/**
 * Outputs pane e2e — boots the production build against a fixture project that
 * carries a `## Deliverables` section with mixed link types (pdf / html / md /
 * URL), switches the left band to the Outputs tab, and opens the in-app HTML
 * preview. Also doubles as the manual-verification screenshot source
 * (tests/screenshots-out/outputs/).
 */

import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bootApp } from './fixtures/electron-app';

const outDir = resolve(__dirname, 'screenshots-out', 'outputs');

async function seedDeliverables(conceptionDir: string): Promise<void> {
  const projectDir = join(conceptionDir, 'projects', '2026-05', '2026-05-20-demo-outputs');
  const outputs = join(projectDir, 'outputs');
  await mkdir(outputs, { recursive: true });

  await writeFile(
    join(projectDir, 'README.md'),
    [
      '---',
      'date: 2026-05-20',
      'kind: project',
      'status: done',
      'apps: []',
      '---',
      '',
      '# Demo outputs',
      '',
      '## Deliverables',
      '',
      '- [Module 1](outputs/module-1.html) — interactive module',
      '- [Report](outputs/report.pdf) — compiled report',
      '- [Summary](outputs/summary.md)',
      '- [Live deploy](https://example.com/module)',
      '',
    ].join('\n'),
    'utf8',
  );

  // HTML with a *relative* sibling asset — the case the condash-file:// preview
  // must resolve. SVG keeps the asset text-only (no binary encoding).
  await writeFile(
    join(outputs, 'module-1.html'),
    [
      '<!doctype html><html><head><meta charset="utf-8"><title>Module 1</title></head>',
      '<body style="font-family:sans-serif;padding:24px">',
      '<h1>Module 1</h1>',
      '<p>Relative sibling asset below:</p>',
      '<img src="logo.svg" width="240" height="120" alt="logo">',
      '</body></html>',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(outputs, 'logo.svg'),
    "<svg xmlns='http://www.w3.org/2000/svg' width='240' height='120'>" +
      "<rect width='100%' height='100%' fill='#2d6cdf'/>" +
      "<text x='20' y='66' fill='#fff' font-size='28' font-family='sans-serif'>sibling.svg</text>" +
      '</svg>\n',
    'utf8',
  );
  await writeFile(join(outputs, 'summary.md'), '# Summary\n\nText.\n', 'utf8');
  await writeFile(join(outputs, 'report.pdf'), '%PDF-1.4\n% demo\n', 'utf8');
}

test('outputs tab aggregates deliverables and previews HTML', async () => {
  const booted = await bootApp({ prepare: seedDeliverables });
  const { app, window, cleanup } = booted;
  try {
    await window.setViewportSize({ width: 1400, height: 900 });
    await window.locator('.edge-strip-left').first().waitFor({ state: 'visible', timeout: 10_000 });

    // Switch the left band from Projects to Outputs via the in-pane tab.
    await window.locator('.left-tab', { hasText: 'Outputs' }).click();

    // One group (only the project that has deliverables), four rows.
    const groups = window.locator('.outputs-group');
    await expect(groups).toHaveCount(1);
    await expect(window.locator('.outputs-group-title')).toHaveText('Demo outputs');
    const rows = window.locator('.outputs-deliverables .deliverable-row');
    await expect(rows).toHaveCount(4);

    await mkdir(outDir, { recursive: true });
    await window.screenshot({ path: join(outDir, 'outputs-pane.png') });

    // Open the local HTML deliverable → in-app preview over condash-file://.
    await window.locator('.deliverable-button', { hasText: 'Module 1' }).click();
    await expect(window.locator('.html-modal')).toBeVisible();
    // Chromium normalises the triple-slash empty-host form to
    // `condash-file://<seg0>/<rest>` (first path segment becomes the host);
    // the protocol handler reconstructs the absolute path from host+pathname.
    const src = await window.locator('.html-webview').getAttribute('src');
    expect(src ?? '').toMatch(/^condash-file:\/\//);
    expect(src ?? '').toMatch(/module-1\.html$/);

    await window.waitForTimeout(400);
    await window.screenshot({ path: join(outDir, 'html-modal.png') });
  } finally {
    await cleanup();
  }
});
