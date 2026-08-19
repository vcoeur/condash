import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

/**
 * End-to-end for the `svg` block: the markup renders on the light card
 * through the SVG sanitizer (style / foreignObject / script dropped, an svg
 * anchor neutralised), the block's css is scoped in, clicking the card opens
 * the lightbox above the visual note, Esc closes only the lightbox, and
 * "Download .svg" writes a standalone file (xmlns, embedded style, tokens
 * resolved to literals) to the picked path.
 */

const SVG = [
  '<svg viewBox="0 0 300 100" width="300" height="100">',
  '  <style>.t { fill: red; }</style>',
  '  <foreignObject width="10" height="10"><div>x</div></foreignObject>',
  '  <script>window.__pwned = 1</script>',
  '  <a href="javascript:alert(1)"><rect x="10" y="20" width="120" height="60" rx="8" fill="var(--wf-accent-soft)" stroke="var(--wf-accent)"/></a>',
  '  <text x="70" y="55" text-anchor="middle" class="t">A</text>',
  '  <image width="1" height="1" href="https://tracker.invalid/p.gif"/>',
  '  <circle cx="200" cy="50" r="10" style="fill:url(https://evil.invalid/x);stroke:red"/>',
  '  <ellipse cx="240" cy="50" rx="10" ry="6" fill="url(https://evil.invalid/paint.svg#p)" stroke="url(\'#g\')"/>',
  '  <defs><linearGradient id="g"/><linearGradient id="h" xlink:href="#g"/></defs>',
  '</svg>',
].join('\n');

const PLAN_MDX = `---
title: Svg demo
---

## Diagram

<Svg id="flow" caption="A box" alt="One box labelled A">

\`\`\`svg
${SVG}
\`\`\`

\`\`\`css
.t { font-size: 14px; font-weight: 600; fill: var(--wf-ink); }
\`\`\`

</Svg>
`;

test('svg block renders sanitized on a light card, opens a lightbox, downloads a standalone file', async () => {
  const booted = await bootApp({
    prepare: async (conceptionDir) => {
      const res = join(conceptionDir, 'resources');
      await mkdir(res, { recursive: true });
      await writeFile(join(res, 'svg-demo.mdx'), PLAN_MDX, 'utf8');
    },
  });
  try {
    const win = booted.window;
    const target = join(booted.conceptionDir, 'downloaded.svg');
    let seededDefault = '';
    await booted.app.evaluate(({ dialog }, filePath) => {
      // Record the seeded default path, then pick the test target.
      (dialog as { showSaveDialog: unknown }).showSaveDialog = async (
        ...args: unknown[]
      ): Promise<{ canceled: boolean; filePath: string }> => {
        const options = args.find(
          (arg): arg is { defaultPath?: string } =>
            typeof arg === 'object' && arg !== null && 'defaultPath' in arg,
        );
        (globalThis as { __seededDefault?: string }).__seededDefault = options?.defaultPath ?? '';
        return { canceled: false, filePath };
      };
    }, target);

    await win.setViewportSize({ width: 1400, height: 900 });
    await win.locator('.rail-item[title*="Resources"]').click();
    await win
      .locator('.resources-card', { hasText: 'svg-demo.mdx' })
      .locator('.resources-card-body')
      .click();
    await expect(win.locator('.mdx-modal')).toBeVisible();

    const card = win.locator('.mdx-modal .plan-svg-card');
    await expect(card).toBeVisible();
    await expect(card.locator('svg rect')).toHaveCount(1);
    // Sanitizer: document-scoped style, foreign content and script are gone;
    // the svg anchor is neutralised; nothing ran.
    await expect(card.locator('style')).toHaveCount(0);
    await expect(card.locator('foreignObject')).toHaveCount(0);
    await expect(card.locator('script')).toHaveCount(0);
    await expect(card.locator('svg a')).toHaveAttribute('href', '#');
    // External references never survive sanitizing: the tracker image loses
    // its href, the external url() style is dropped, the fragment xlink stays.
    await expect(card.locator('svg image')).not.toHaveAttribute('href', /.+/);
    await expect(card.locator('svg circle')).not.toHaveAttribute('style', /.+/);
    await expect(card.locator('svg linearGradient#h')).toHaveAttribute('xlink:href', '#g');
    // One rule for every attribute: an external paint server goes, a quoted
    // fragment stays.
    await expect(card.locator('svg ellipse')).not.toHaveAttribute('fill', /.+/);
    await expect(card.locator('svg ellipse')).toHaveAttribute('stroke', "url('#g')");
    expect(await win.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
    // The block's css fence is scoped to the block and applied (ink, not red).
    const textFill = await card.locator('svg text').evaluate((el) => getComputedStyle(el).fill);
    expect(textFill).toBe('rgb(26, 20, 24)');
    // Light card in every theme.
    const cardBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(cardBg).toBe('rgb(255, 255, 255)');

    // Click → lightbox above the note; Esc closes only the lightbox.
    await card.click();
    const lightbox = win.locator('.svg-lightbox');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.locator('.svg-lightbox-card svg rect')).toHaveCount(1);
    // The card carries `contain: paint` + `overflow: hidden`, so the lightbox
    // must have escaped it (Portal) and be the element actually under its
    // own centre — `toBeVisible()` alone cannot tell a clipped overlay apart.
    const escaped = await lightbox.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        insideCard: el.closest('.plan-svg-card') !== null,
        insideRoot: el.closest('#root') !== null,
        hitInside: hit !== null && el.contains(hit),
      };
    });
    expect(escaped).toEqual({ insideCard: false, insideRoot: false, hitInside: true });
    await win.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
    await expect(win.locator('.mdx-modal')).toBeVisible();

    // Download writes a standalone file.
    await card.click();
    await expect(lightbox).toBeVisible();
    await lightbox.locator('button', { hasText: 'Download .svg' }).click();
    await expect(lightbox.locator('.modal-saved[title="SVG saved"]')).toBeVisible({
      timeout: 10000,
    });
    seededDefault = await booted.app.evaluate(
      () => (globalThis as { __seededDefault?: string }).__seededDefault ?? '',
    );
    expect(seededDefault.endsWith('/resources/svg-demo-flow.svg')).toBe(true);

    const file = await readFile(target, 'utf8');
    expect(file.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(file).toContain('<style>');
    expect(file).toContain('#1a1418');
    expect(file).toContain('#672167');
    expect(file).not.toContain('var(--wf');
    expect(file).not.toContain('<script');
    expect(file).not.toContain('foreignObject');
    expect(file).not.toContain('tracker.invalid');
    expect(file).not.toContain('evil.invalid');
    expect(file).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  } finally {
    await booted.cleanup();
  }
});
