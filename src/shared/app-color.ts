/**
 * Per-app colour assignment for card pills (Projects pane + Code pane).
 *
 * The same app name always lands on the same palette slot so the eye can
 * pair a project card's apps row with the matching code-pane card without
 * any config. Index = sum-of-codepoints mod palette length — deterministic,
 * locale-agnostic, no hashing dependency.
 *
 * Normalisation: leading `@` is trimmed (a project's `apps: ["@condash"]`
 * collides with the bare `condash` repo name) and the result is
 * lower-cased so `Condash` / `condash` share a slot.
 */

/** Number of distinct slots; matches `PALETTE` below. */
export const APP_COLOR_SLOT_COUNT = 10;

/**
 * Resolve an app name to a 0-based palette slot. Pure function; same input
 * always yields the same slot regardless of host or session.
 */
export function appColorSlot(name: string): number {
  const normalised = normaliseAppName(name);
  if (normalised.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < normalised.length; i++) {
    sum = (sum + normalised.charCodeAt(i)) % APP_COLOR_SLOT_COUNT;
  }
  return sum;
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
