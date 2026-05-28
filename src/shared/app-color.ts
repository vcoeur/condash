/**
 * Per-app colour assignment for card pills (Projects pane + Code pane).
 *
 * The same app name always lands on the same palette slot so the eye can
 * pair a project card's apps row with the matching code-pane card without
 * any config. Hash = djb2 mod palette length — deterministic,
 * locale-agnostic, no hashing dependency. djb2 spreads adjacent-name
 * inputs across the palette far better than a naive sum-of-codepoints
 * (which clusters because every name in a repo set shares most of the
 * same characters).
 *
 * Normalisation: leading `@` is trimmed (a project's `apps: ["@condash"]`
 * collides with the bare `condash` repo name) and the result is
 * lower-cased so `Condash` / `condash` share a slot.
 */

/** Number of distinct slots; matches the palette in `app-pill.css`. */
export const APP_COLOR_SLOT_COUNT = 20;

/**
 * Resolve an app name to a 0-based palette slot. Pure function; same input
 * always yields the same slot regardless of host or session.
 */
export function appColorSlot(name: string): number {
  const normalised = normaliseAppName(name);
  if (normalised.length === 0) return 0;
  // djb2 (Daniel Bernstein) — h = h * 33 + c, seed 5381. The bitwise OR
  // with 0 forces a 32-bit signed int after every step so the value
  // doesn't drift into floating-point land, which would skew the modulo.
  let h = 5381;
  for (let i = 0; i < normalised.length; i++) {
    h = (h * 33 + normalised.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % APP_COLOR_SLOT_COUNT;
}

/**
 * Resolve an app name to the CSS-class suffix used by the `.app-pill`
 * styles (`app-pill-0` … `app-pill-9`). Renderer call sites concatenate
 * this with the base `app-pill` class.
 */
export function appColorClass(name: string): string {
  return `app-pill-${appColorSlot(name)}`;
}

function normaliseAppName(name: string): string {
  return name.replace(/^@+/, '').trim().toLowerCase();
}
