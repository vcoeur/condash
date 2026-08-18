/**
 * Deterministic family colour for Projects-pane cards.
 *
 * The Projects pane colours a card by the project *family* it belongs to,
 * never by its status: the family's root — the topmost item the `parent:`
 * chain resolves to — gets a stable hue derived from its slug, and every
 * descendant wears the same hue so a plan and its implementation children, at
 * any depth, read as one coloured group. The card component applies the class
 * only to cards that are in a family (they have children, or their parent
 * resolves); a standalone card keeps a neutral frame. The status is carried by
 * the section's left rail instead (see `projects-pane.css`).
 *
 * The slot count here must match the `.row.proj-family-<n>` palette in
 * `projects-pane.css`.
 */

/** Number of distinct project-family colour slots; matches the
 *  `.row.proj-family-*` palette in `projects-pane.css`. */
export const PROJECT_COLOR_SLOT_COUNT = 16;

/**
 * The topmost item reachable from `slug` by following `parent:` links that
 * resolve — the key every card in the family hashes its colour from.
 *
 * - A root, a standalone item, or an item whose parent slug resolves to
 *   nothing is its own root (a dangling link ends the walk at the last
 *   resolving item, so a node with children under a dead link heads its own
 *   family).
 * - A cycle (`a → b → a`; the parser rejects only a self-reference, and a
 *   hand-edited README can produce a longer loop) ends the walk, and every
 *   member of the loop gets the same root — the smallest slug in it — so the
 *   cards still share one hue instead of each hashing where its own walk
 *   happened to close.
 *
 * @param slug the item to resolve
 * @param parentOf the item's `parent:` slug when it resolves to a real item,
 *   else `undefined` / `null` / `''`
 * @returns the family root's slug
 */
export function familyRootOf(
  slug: string,
  parentOf: (slug: string) => string | null | undefined,
): string {
  const path: string[] = [];
  let current = slug;
  for (;;) {
    const seenAt = path.indexOf(current);
    if (seenAt !== -1) {
      // Closed a loop: `path[seenAt..]` is the cycle. Pick one stable member.
      return path.slice(seenAt).reduce((min, s) => (s < min ? s : min));
    }
    path.push(current);
    const parent = parentOf(current);
    if (!parent) return current;
    current = parent;
  }
}

/**
 * Resolve a family key to a 0-based colour slot. Same key always yields the
 * same slot regardless of host or session — djb2 (`h = h * 33 + c`, seed 5381)
 * mod palette length, mirroring `appColorSlot` in `app-color.ts`.
 *
 * @param key the family root slug from {@link familyRootOf}
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
 * The CSS-class suffix for a family's colour: `proj-family-0` …
 * `proj-family-15`. Card call sites concatenate it with the base `row` class.
 *
 * @param familyRoot the family root slug from {@link familyRootOf}
 */
export function projectColorClass(familyRoot: string): string {
  return `proj-family-${projectColorSlot(familyRoot)}`;
}
