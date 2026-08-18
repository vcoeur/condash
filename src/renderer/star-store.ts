import { createSignal } from 'solid-js';

// Shared starred-project set behind the Projects-pane card stars.
//
// Storage is the conception-scoped `starredProjects` key in
// `<conception>/.condash/settings.json` — deliberately not the item README,
// because the sweeper commits every settled README change and starring is
// transient attention rather than project history. Module scope mirrors
// `pr-index-store.ts` (and the `overStatus` drag signal in
// projects-parts/cards.tsx): the *read* is a cross-cutting card concern taken
// directly by the leaf rather than threaded through GroupBlock / SubGroup /
// Card. The *write* stays a threaded `onToggleStar` prop like every other card
// action, so its failure toast lives beside the sibling optimistic mutations in
// `hooks/use-project-actions.ts`.

/** Starred project slugs. Empty until the first load resolves. */
const [starred, setStarred] = createSignal<ReadonlySet<string>>(new Set());

// Monotonic generation guard: a slow load must not overwrite a newer one (a
// conception switch mid-fetch, or a toggle that lands while a load is in
// flight).
let generation = 0;

/** Reactive read of the whole set — pass to the pane's sorts so a toggle
 *  re-orders the affected section. */
export function starredSlugs(): ReadonlySet<string> {
  return starred();
}

/** Reactive membership test — a card's star re-renders when its slug's state
 *  changes. */
export function isStarred(slug: string): boolean {
  return starred().has(slug);
}

/**
 * Load the starred set for the active conception, replacing whatever is held.
 * Never throws — a failed read leaves the set empty, which degrades to "no
 * card is starred" rather than breaking the pane.
 */
export async function reloadStarred(): Promise<void> {
  const mine = ++generation;
  try {
    const slugs = await window.condash.getStarredProjects();
    if (mine !== generation) return;
    setStarred(new Set(slugs));
  } catch {
    if (mine !== generation) return;
    setStarred(new Set<string>());
  }
}

/**
 * Flip one project's star and persist it. Optimistic: the set updates before
 * the IPC resolves so the card and its section re-order immediately, and the
 * previous set is restored if the write fails.
 *
 * @param slug the project slug to toggle
 * @param onError called with a human-readable message when the write failed
 * @returns the resulting starred state, or the unchanged one on failure
 */
export async function toggleStar(
  slug: string,
  onError?: (message: string) => void,
): Promise<boolean> {
  const previous = starred();
  const next = !previous.has(slug);
  const optimistic = new Set(previous);
  if (next) optimistic.add(slug);
  else optimistic.delete(slug);
  const mine = ++generation;
  setStarred(optimistic);
  try {
    const slugs = await window.condash.setProjectStar(slug, next);
    // A newer toggle or conception switch started while this write was in
    // flight — its result is the current truth, so drop ours.
    if (mine !== generation) return next;
    setStarred(new Set(slugs));
    return next;
  } catch (err) {
    if (mine === generation) setStarred(previous);
    onError?.(`Could not ${next ? 'star' : 'unstar'} project: ${(err as Error).message}`);
    return !next;
  }
}
