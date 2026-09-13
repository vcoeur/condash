import { test, expect } from '@playwright/test';
import { THEME_PRESETS } from '../src/shared/themes';
import { bootApp, type BootedApp } from './fixtures/electron-app';

interface SurfaceRatios {
  pagePane: number;
  paneCard: number;
  pageCard: number;
}

interface ThemeSurfaceResult {
  id: string;
  colors: Record<'page' | 'pane' | 'card', string>;
  ratios: SurfaceRatios;
}

/** Parse an opaque computed RGB colour into linear-light luminance. */
function luminance(color: string): number | null {
  const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
  if (!match) return null;
  const channels = match.slice(1).map((value) => Number(value) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** Calculate the W3C relative-luminance contrast ratio for two opaque colours. */
function contrastRatio(first: string, second: string): number | null {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  if (firstLuminance === null || secondLuminance === null) return null;
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

/** Read the three resolved opaque surface tokens through mounted DOM probes. */
async function readSurfaces(booted: BootedApp): Promise<Record<'page' | 'pane' | 'card', string>> {
  return booted.window.evaluate(() => {
    const probes = {
      page: '--bg',
      pane: '--bg-panel',
      card: '--bg-elevated',
    } as const;
    const result: Partial<Record<'page' | 'pane' | 'card', string>> = {};
    for (const [name, token] of Object.entries(probes)) {
      const probe = document.createElement('div');
      probe.style.background = `var(${token})`;
      document.body.append(probe);
      result[name as keyof typeof probes] = getComputedStyle(probe).backgroundColor;
      probe.remove();
    }
    return result as Record<'page' | 'pane' | 'card', string>;
  });
}

test('theme surface tokens resolve to opaque colours and Warm Gallery separates every surface pair', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const results: ThemeSurfaceResult[] = [];
  for (const preset of THEME_PRESETS) {
    const booted = await bootApp({ globalConfig: { theme: preset.id } });
    try {
      await expect
        .poll(() => booted.window.evaluate(() => document.documentElement.dataset.theme))
        .toBe(preset.id);
      const colors = await readSurfaces(booted);
      const pagePane = contrastRatio(colors.page, colors.pane);
      const paneCard = contrastRatio(colors.pane, colors.card);
      const pageCard = contrastRatio(colors.page, colors.card);
      expect(pagePane, `${preset.label} page/pane must resolve to opaque RGB`).not.toBeNull();
      expect(paneCard, `${preset.label} pane/card must resolve to opaque RGB`).not.toBeNull();
      expect(pageCard, `${preset.label} page/card must resolve to opaque RGB`).not.toBeNull();
      results.push({
        id: preset.id,
        colors,
        ratios: { pagePane: pagePane!, paneCard: paneCard!, pageCard: pageCard! },
      });
    } finally {
      await booted.cleanup();
    }
  }

  await testInfo.attach('theme-surface-ratios.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });
  const warmGallery = results.find((result) => result.id === 'dark')!;
  expect(warmGallery.ratios.pagePane).toBeGreaterThanOrEqual(1.12);
  expect(warmGallery.ratios.paneCard).toBeGreaterThanOrEqual(1.12);
  expect(warmGallery.ratios.pageCard).toBeGreaterThanOrEqual(1.12);
});
