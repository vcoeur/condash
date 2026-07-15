/**
 * Deterministic per-project card colour for the Projects pane.
 *
 * The Projects pane colours each card by the project *family* it belongs to
 * rather than by its status: a standalone project gets a stable hue derived
 * from its slug, and a spin-off subproject inherits its parent's hue so a plan
 * and its implementation children read as one coloured group. The status is
 * carried by the section's left rail instead (see `projects-pane.css`).
 *
 * The slot count here must match the `.row.proj-family-<n>` palette in
 * `projects-pane.css`.
 */

/** Number of distinct project-family colour slots; matches the
 *  `.row.proj-family-*` palette in `projects-pane.css`. */
export const PROJECT_COLOR_SLOT_COUNT = 16;

/** The subset of a project a card needs to derive its family colour. */
export interface ProjectColorRef {
  slug: string;
  parent?: string | null;
}

/**
 * The key that colours a card. A subproject shares its parent's slug so parent
 * and children land on the same slot; a root project uses its own slug.
 *
 * @param item project slug plus optional parent slug
 * @returns the family key to hash
 */
export function projectFamilyKey(item: ProjectColorRef): string {
  return item.parent && item.parent.length > 0 ? item.parent : item.slug;
}

/**
 * Resolve a family key to a 0-based colour slot. Same key always yields the
 * same slot regardless of host or session — djb2 (`h = h * 33 + c`, seed 5381)
 * mod palette length, mirroring `appColorSlot` in `app-color.ts`.
 *
 * @param key the family key from {@link projectFamilyKey}
 * @returns a slot in `[0, PROJECT_COLOR_SLOT_COUNT)`
 */
export function projectColorSlot(key: string): number {
  if (key.length === 0) return 0;
  // Force a 32-bit signed int after every step so the value doesn't drift into
  // floating-point land, which would skew the modulo.
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = (h * 33 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % PROJECT_COLOR_SLOT_COUNT;
}

/**
 * The CSS-class suffix for a project's family colour: `proj-family-0` …
 * `proj-family-15`. Card call sites concatenate it with the base `row` class.
 *
 * @param item project slug plus optional parent slug
 */
export function projectColorClass(item: ProjectColorRef): string {
  return `proj-family-${projectColorSlot(projectFamilyKey(item))}`;
}
