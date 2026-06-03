/**
 * Process-agnostic config contract for the `repositories` list in the two
 * settings files (`settings.json` / `condash.json`).
 *
 * These are the raw, pre-validation shapes a user can write by hand, plus the
 * pure `isSectionMarker` discriminator. They live in `shared/` so both the main
 * process (zod schemas, the config walker, worktree plumbing) and the renderer
 * (the Settings modal) reference one definition without the renderer pulling
 * the zod-based schema layer in `main/config-schema.ts` into its bundle. The
 * zod schemas, migrations, and canonicalisers stay in `main/config-schema.ts`
 * and validate against these types.
 */

/**
 * A submodule entry: the same shape as a top-level repo, minus the recursive
 * `submodules` (no nested submodules) and the section-marker variant
 * (sections are top-level only).
 */
export type RawSubmoduleRepo =
  | string
  | {
      handle?: string;
      name?: string;
      path?: string;
      label?: string;
      aliases?: string[];
      run?: string;
      force_stop?: string;
      install?: string;
      pinned_branch?: string;
      env?: string[];
    };

/**
 * A top-level entry: a name string, a full repo object (with optional
 * `submodules`), or a section marker that groups everything until the next
 * marker into a labelled bucket. Section markers carry no behaviour — they only
 * steer the Settings UI and the Code pane's card grouping; the walker in
 * `main/config-walk.ts` strips them out before any consumer sees the list.
 */
export type RawRepo =
  | string
  | {
      handle?: string;
      name?: string;
      path?: string;
      label?: string;
      aliases?: string[];
      run?: string;
      force_stop?: string;
      install?: string;
      pinned_branch?: string;
      env?: string[];
      submodules?: RawSubmoduleRepo[];
    }
  | { section: string };

/** True when `entry` is the section-marker variant of `RawRepo`. */
export function isSectionMarker(entry: RawRepo): entry is { section: string } {
  return typeof entry === 'object' && entry !== null && 'section' in entry;
}
