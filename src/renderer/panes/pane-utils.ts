/**
 * Format a tree-relative path into the section header label rendered
 * by Resources, Skills, and Knowledge panes — e.g.
 *   ""              → "ROOT"
 *   "topics"        → "TOPICS"
 *   "topics/code"   → "TOPICS · CODE"
 *
 * Each pane previously inlined this `dirRel.split('/').join(' · ').toUpperCase()`
 * recipe; pulled out for consistency so a future label-style change
 * happens in one place.
 */
export function formatSectionLabel(relPath: string): string {
  if (relPath === '') return 'ROOT';
  return relPath.split('/').join(' · ').toUpperCase();
}
