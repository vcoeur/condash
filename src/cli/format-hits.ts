/**
 * Shared human-format rendering for `SearchHit[]` lists. Both `condash search`
 * and `condash projects search` print hits the same way — `relPath: snippet`
 * with the snippet whitespace-collapsed and capped — so the rendering lives
 * here rather than being re-typed (with subtle drift) in each command.
 */
import type { SearchHit } from '../shared/types';

/** Snippet character cap shared by both search commands. */
const SNIPPET_CAP = 120;

/**
 * Render one search hit as `relPath: snippet`. The first snippet's text is
 * whitespace-collapsed (so multi-line matches read on one line) and capped at
 * {@link SNIPPET_CAP} characters; a hit with no snippet renders as `relPath: `.
 */
export function formatSearchHitLine(hit: SearchHit): string {
  const snippet = hit.snippets[0]?.text.replace(/\s+/g, ' ').slice(0, SNIPPET_CAP) ?? '';
  return `${hit.relPath}: ${snippet}`;
}

/**
 * Render a list of hits, one per line, terminated by a newline. `emptyMessage`
 * (already newline-terminated by the caller) is returned verbatim when there
 * are no hits.
 */
export function formatSearchHitsHuman(hits: readonly SearchHit[], emptyMessage: string): string {
  if (hits.length === 0) return emptyMessage;
  return hits.map(formatSearchHitLine).join('\n') + '\n';
}
