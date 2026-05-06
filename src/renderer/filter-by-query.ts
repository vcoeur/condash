/**
 * Filter a list of tree nodes by a free-text query, matching the lowercase
 * query against each node's `title` and `relPath`. Empty query returns the
 * input unchanged.
 *
 * Pulled out of `panes/resources.tsx` and `panes/skills.tsx` where the
 * exact same shape was duplicated. Both panes' node types carry the
 * `title` + `relPath` pair, so the generic constraint matches both.
 */
export function filterByQuery<T extends { title: string; relPath: string }>(
  items: T[],
  query: string,
): T[] {
  if (query.trim().length === 0) return items;
  const lower = query.toLowerCase();
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(lower) || item.relPath.toLowerCase().includes(lower),
  );
}
