/**
 * App identity + per-app colour for card pills (Projects pane + Code pane).
 *
 * One app has exactly one **handle** — the canonical, lowercase reference used
 * everywhere it's named: the `#handle` pill in both panes, a project README's
 * `apps:` list, the generated AGENTS.md table, the colour hash, and search
 * keywords. Registered repos carry an explicit `handle:` in `condash.json`;
 * any other reference (a bare legacy name, or an absolute path to an
 * unregistered repo) is reduced to a handle by {@link appHandle}.
 *
 * This module owns the single normalisation rule. It replaced three divergent
 * ones (a colour-only sigil-strip, a search-only dots→hyphens slug, and the raw
 * directory name on the code card) — they disagreed on inputs like
 * `notes.vcoeur.com`, so "is this the same app?" depended on which call site
 * asked. Now every call site funnels through `appHandle`.
 */

import { toPosix } from './path';

/** Number of distinct slots; matches the palette in `app-pill.css`. */
export const APP_COLOR_SLOT_COUNT = 20;

/**
 * Reduce any app reference to its handle: the canonical lowercase token that
 * identifies one app. Pure and locale-agnostic.
 *
 * Rules, in order: trim; strip leading `#`; if the value is a path (absolute,
 * `~`-rooted, or containing a slash) take its last non-empty segment; lowercase.
 * Dots are preserved — an explicit handle never carries a domain suffix, and an
 * unregistered abs-path app keeps its directory basename verbatim.
 *
 * Only the `#` sigil is stripped: a leading `@` (the retired sigil) is left
 * intact so it fails to resolve and `applications validate` flags it.
 *
 * @param ref a `#handle`, a bare name, or an absolute/relative path
 * @returns the handle (no leading `#`), or `''` for an empty/`#`-only input
 */
export function appHandle(ref: string): string {
  let value = toPosix(ref.trim()).replace(/^#+/, '');
  if (value.includes('/') || value.startsWith('~')) {
    const segments = value.replace(/\/+$/, '').split('/');
    value = segments[segments.length - 1] ?? '';
  }
  return value.toLowerCase();
}

/**
 * Render an app reference as its pill text: the handle with a single leading
 * `#`. Both panes call this so the same app reads identically everywhere.
 */
export function appPillText(ref: string): string {
  return `#${appHandle(ref)}`;
}

/**
 * Resolve an app reference to a 0-based palette slot. Same handle always yields
 * the same slot regardless of host or session.
 *
 * Hash = djb2 mod palette length — deterministic, no hashing dependency. djb2
 * (h = h * 33 + c, seed 5381) spreads adjacent-name inputs across the palette
 * far better than a naive sum-of-codepoints, which clusters because every name
 * in one repo set shares most of its characters.
 */
export function appColorSlot(ref: string): number {
  const handle = appHandle(ref);
  if (handle.length === 0) return 0;
  // The bitwise OR with 0 forces a 32-bit signed int after every step so the
  // value doesn't drift into floating-point land, which would skew the modulo.
  let h = 5381;
  for (let i = 0; i < handle.length; i++) {
    h = (h * 33 + handle.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % APP_COLOR_SLOT_COUNT;
}

/**
 * Resolve an app reference to the CSS-class suffix used by the `.app-pill`
 * styles (`app-pill-0` … `app-pill-19`). Renderer call sites concatenate this
 * with the base `app-pill` class.
 */
export function appColorClass(ref: string): string {
  return `app-pill-${appColorSlot(ref)}`;
}
