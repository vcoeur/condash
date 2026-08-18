/**
 * Pure helpers for ranking projects by status and counting step markers.
 * Both bits used to be duplicated across main, CLI, and renderer; the only
 * thing that varied was whether a particular caller had a `Project` already
 * or only its `status` string.
 */
import { KNOWN_STATUSES, type Step, type StepCounts, type StepMarker } from './types';

/**
 * Index of `status` in `KNOWN_STATUSES`, with unknown statuses sorted last.
 * Mirrors how the on-screen Projects pane and the CLI both display "now"
 * before "review" before "later" before "backlog" before "done".
 */
export function statusOrder(status: string): number {
  const idx = (KNOWN_STATUSES as readonly string[]).indexOf(status);
  return idx === -1 ? KNOWN_STATUSES.length : idx;
}

/**
 * Default project ordering: by status rank (`statusOrder`), then slug
 * alphabetically as the tie-break. The Projects-pane IPC list and the CLI
 * `projects list` both default to this exact ordering — sharing it here keeps
 * the two from drifting.
 *
 * @param a project-like row carrying a `status` and `slug`
 * @param b the other row
 */
export function compareByStatusThenSlug(
  a: { status: string; slug: string },
  b: { status: string; slug: string },
): number {
  const order = statusOrder(a.status) - statusOrder(b.status);
  if (order !== 0) return order;
  return a.slug.localeCompare(b.slug);
}

/**
 * The slug without its `YYYY-MM-DD-` prefix — the short form the CLI accepts
 * (`condash projects read <short>`), the `{shortSlug}` action-template
 * variable, and the identifier line on a project card. A slug carrying no
 * date prefix comes back unchanged.
 *
 * @param slug full item slug (the dated directory name)
 */
export function shortSlug(slug: string): string {
  return slug.replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

/** Tally `[ ] / [~] / [x] / [!] / [-]` markers in the README's `## Steps`
 * section only — milestone count. Entries living under `## Step details`,
 * `## Notes`, or any other section are tracked by the parser for editing
 * purposes but excluded from the card-face "N/M steps" tally, which is
 * meant to reflect just the milestones. Case-insensitive on the section
 * name; multiple `## Steps` headings (rare but legal) all contribute. */
export function countSteps(steps: readonly Step[]): StepCounts {
  const counts: StepCounts = { todo: 0, doing: 0, done: 0, blocked: 0, dropped: 0 };
  for (const step of steps) {
    if (step.section.trim().toLowerCase() !== 'steps') continue;
    const marker: StepMarker = step.marker;
    if (marker === ' ') counts.todo++;
    else if (marker === '~') counts.doing++;
    else if (marker === 'x') counts.done++;
    else if (marker === '!') counts.blocked++;
    else if (marker === '-') counts.dropped++;
  }
  return counts;
}

/**
 * Sanitise a raw `starredProjects` config value into a deduped slug list, in
 * sorted order. Defensive because the value comes straight off disk — the
 * effective-config read is a plain spread with no zod pass, so a hand-edited
 * `.condash/settings.json` can carry a non-array, nested objects, or blanks
 * (same contract as `resolveTreeExpansion`: a corrupt file must not reach the
 * renderer). Sorted so the persisted array is stable across toggles and reads
 * as a set rather than a history.
 *
 * @param value the raw `starredProjects` value, any shape
 * @returns the slugs, deduped and sorted; empty for any unusable input
 */
export function normaliseStarredSlugs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const slug = entry.trim();
    if (slug) seen.add(slug);
  }
  return [...seen].sort();
}

/**
 * Add or remove one slug from a starred-slug list. Pure — the caller persists
 * the result.
 *
 * @param current the existing list (any raw shape; normalised first)
 * @param slug the project slug to star or unstar
 * @param starred true to star, false to unstar
 * @returns the new deduped, sorted list
 */
export function applyStarredSlug(current: unknown, slug: string, starred: boolean): string[] {
  const slugs = new Set(normaliseStarredSlugs(current));
  if (starred) slugs.add(slug);
  else slugs.delete(slug);
  return [...slugs].sort();
}
