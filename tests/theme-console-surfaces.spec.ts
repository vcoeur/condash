/**
 * Console's surface rules — the mockup-F signatures that tokens could not reach.
 *
 * The preset's colour / radius / type are a token block in `styles.css` and need
 * no test: a wrong hex is a wrong hex. These four are *shapes*, layered on in
 * `theme-console.css`, and each one overrides a pane stylesheet — so the thing
 * worth guarding is that the override still lands (specificity, import order, a
 * renamed base class) and that it stays inside Console.
 *
 * The rail's reverse-video active (solid accent fill + ink icon) is no longer a
 * Console signature: it became the base `.rail-item.active` rule in `app-shell.css`
 * for every theme (2026-08, rail-visibility), so the rail pair asserts the base
 * fill under both presets rather than a Console-only override.
 *
 * Every assertion is therefore paired: the treatment is present under `console`
 * and absent under `dark`. A one-sided check would still pass if the rules
 * leaked into every theme, which is the failure mode that actually matters.
 * (For the rail, the "leak" dimension is inverted by design — see above.)
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
  railActiveColor: string;
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
      railActiveColor: read('.rail-item.active')?.color ?? 'MISSING',
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

    // The rail's reverse-video fill is the BASE rule now (app-shell.css), so
    // there is no Console-only settle race to wait out — the base paints accent
    // on the first active frame. The poll below stays for console because a
    // broken base rule never settles, so the poll still fails and the guard
    // holds. (Known flake, pre-existing on main: when `[data-theme]` flips
    // after the rail's first style computation, Chromium can pin the computed
    // `background` to the pre-flip accent — the poll can't out-wait a pinned
    // value, and neither can the app; CI's retries absorb it.)
    const accent = await resolvedColor(booted, '--accent');
    await expect
      .poll(
        () =>
          booted.window.evaluate(() => {
            const el = document.querySelector('.rail-item.active');
            return el ? getComputedStyle(el).backgroundColor : 'MISSING';
          }),
        // Generous window: under a heavily loaded tag-time runner the bootstrap
        // round-trip and stylesheet apply are slow, and the default 5 s poll can
        // expire before the fill lands. Still far under the 60 s test budget.
        { timeout: 15_000 },
      )
      .toBe(accent);

    const seen = await surfaces(booted);

    // Every selector must have matched something — a renamed base class would
    // otherwise leave this test asserting nothing.
    expect(Object.values(seen)).not.toContain('MISSING');

    // 1. Reverse video: the active rail item is filled with the accent itself,
    //    with the accent-ink surface printed on top (base rule, every theme).
    expect(seen.railActiveBg).toBe(accent);
    expect(seen.railActiveColor).toBe(await resolvedColor(booted, '--accent-ink'));
    // The ink assertion alone would pass vacuously if the theme's `--accent-ink`
    // mapping were dropped — both sides would fall back to the inherited body
    // colour. The ink must differ from the body text to prove it is mapped.
    expect(seen.railActiveColor).not.toBe(await resolvedColor(booted, '--text'));
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
    // The rail's reverse-video fill is the BASE rule, so it must hold under Warm
    // Gallery too — this is the rail pair's "present" half. What must NOT leak
    // are the console-only shapes below (caret, square dots, progress bars).
    expect(seen.railActiveBg).toBe(await resolvedColor(booted, '--accent'));
    expect(seen.railActiveColor).toBe(await resolvedColor(booted, '--accent-ink'));
    // Non-vacuous ink check — see the console pair's note.
    expect(seen.railActiveColor).not.toBe(await resolvedColor(booted, '--text'));
    expect(seen.paneTitleCaret).toBe('none');
    expect(seen.laneDotRadius).not.toBe('0px');
    expect(seen.progressFill).toBe('none');
  } finally {
    await booted.cleanup();
  }
});
