/**
 * Console's surface rules — the mockup-F signatures that tokens could not reach.
 *
 * The preset's colour / radius / type are a token block in `styles.css` and need
 * no test: a wrong hex is a wrong hex. These four are *shapes*, layered on in
 * `theme-console.css`, and each one overrides a pane stylesheet — so the thing
 * worth guarding is that the override still lands (specificity, import order, a
 * renamed base class) and that it stays inside Console.
 *
 * Every assertion is therefore paired: the treatment is present under `console`
 * and absent under `dark`. A one-sided check would still pass if the rules
 * leaked into every theme, which is the failure mode that actually matters.
 */

import { test, expect } from '@playwright/test';
import { bootApp, type BootedApp } from './fixtures/electron-app';

/** Resolve a CSS custom property to the colour Chromium computes for it, so
 *  assertions compare against the live token instead of a hex literal that a
 *  palette re-tune would falsify. */
async function resolvedColor(booted: BootedApp, token: string): Promise<string> {
  return booted.window.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

/** The four treatments, read off the live DOM in one round-trip. */
async function surfaces(booted: BootedApp): Promise<{
  railActiveBg: string;
  paneTitleCaret: string;
  laneDotRadius: string;
  progressFill: string;
}> {
  return booted.window.evaluate(() => {
    const read = (selector: string): CSSStyleDeclaration | null => {
      const el = document.querySelector(selector);
      return el ? getComputedStyle(el) : null;
    };
    const title = document.querySelector('.pane-header-title');
    return {
      railActiveBg: read('.rail-item.active')?.backgroundColor ?? 'MISSING',
      paneTitleCaret: title ? getComputedStyle(title, '::before').content : 'MISSING',
      laneDotRadius: read('.group-header .dot')?.borderRadius ?? 'MISSING',
      progressFill: read('.row .progress-fill')?.backgroundImage ?? 'MISSING',
    };
  });
}

test('Console paints the four mockup-F surface rules', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({ globalConfig: { theme: 'console' } });
  try {
    await expect(booted.window.locator('.rail-item.active').first()).toBeVisible();
    const seen = await surfaces(booted);

    // Every selector must have matched something — a renamed base class would
    // otherwise leave this test asserting nothing.
    expect(Object.values(seen)).not.toContain('MISSING');

    // 1. Reverse video: the active rail item is filled with the accent itself,
    //    not the accent-soft wash the other presets tint it with.
    expect(seen.railActiveBg).toBe(await resolvedColor(booted, '--accent'));
    // 2. `› TITLE ────` — the accent caret in front of the pane title.
    expect(seen.paneTitleCaret).toBe('"›"');
    // 3. Square status blocks.
    expect(seen.laneDotRadius).toBe('0px');
    // 4. Segmented progress bars.
    expect(seen.progressFill).toContain('repeating-linear-gradient');
  } finally {
    await booted.cleanup();
  }
});

test('none of them leak into Warm Gallery', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({ globalConfig: { theme: 'dark' } });
  try {
    await expect(booted.window.locator('.rail-item.active').first()).toBeVisible();
    const seen = await surfaces(booted);

    expect(Object.values(seen)).not.toContain('MISSING');
    expect(seen.railActiveBg).not.toBe(await resolvedColor(booted, '--accent'));
    expect(seen.paneTitleCaret).toBe('none');
    expect(seen.laneDotRadius).not.toBe('0px');
    expect(seen.progressFill).toBe('none');
  } finally {
    await booted.cleanup();
  }
});
