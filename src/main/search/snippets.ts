import type { SearchHighlight, SearchRegion, SearchSnippet, SearchTerm } from '../../shared/types';
import type { RegionLookup } from './regions';

const MAX_SNIPPETS = 3;
const SNIPPET_RADIUS = 60;

/** Region precedence for snippet ordering — meta hits surface first, then
 * the title, then headings, then the body. Path hits are surfaced separately
 * via `SearchHit.pathMatches` and don't produce snippets here. */
const REGION_RANK: Record<SearchRegion, number> = {
  meta: 0,
  h1: 1,
  heading: 2,
  body: 3,
  path: 4,
};

interface Candidate {
  offset: number;
  length: number;
  tokenIndex: number;
  region: SearchRegion;
}

/**
 * Extract up to N snippets from the source, prioritising matches in
 * higher-ranked regions (meta > h1 > heading > body). Snippets are
 * non-overlapping — once a window is committed, later candidates that fall
 * inside it are skipped.
 *
 * Each snippet records *all* token matches inside its text (re-scanned over
 * the snippet substring so offsets are local), enabling per-token highlight
 * colours in the renderer.
 */
export function buildSnippets(
  raw: string,
  terms: readonly SearchTerm[],
  regions: RegionLookup,
): SearchSnippet[] {
  const lower = raw.toLowerCase();

  const candidates: Candidate[] = [];
  for (const term of terms) {
    let cursor = 0;
    while (cursor < lower.length) {
      const idx = lower.indexOf(term.value, cursor);
      if (idx === -1) break;
      candidates.push({
        offset: idx,
        length: term.value.length,
        tokenIndex: term.index,
        region: regions.regionAt(idx),
      });
      cursor = idx + term.value.length;
    }
  }

  candidates.sort((a, b) => {
    const r = REGION_RANK[a.region] - REGION_RANK[b.region];
    return r !== 0 ? r : a.offset - b.offset;
  });

  const used: { start: number; end: number }[] = [];
  const out: SearchSnippet[] = [];

  for (const cand of candidates) {
    if (out.length >= MAX_SNIPPETS) break;
    const start = Math.max(0, cand.offset - SNIPPET_RADIUS);
    const end = Math.min(raw.length, cand.offset + cand.length + SNIPPET_RADIUS);
    if (used.some((r) => start < r.end && end > r.start)) continue;
    used.push({ start, end });

    const slice = raw.slice(start, end);
    // Collapse runs of whitespace to single spaces. Track the offset shift so
    // we can recompute snippet-local match offsets from the source offsets.
    const text = collapseWhitespace(slice);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < raw.length ? '…' : '';
    const finalText = `${prefix}${text}${suffix}`;

    const matches = collectSnippetMatches(finalText, terms);
    out.push({ text: finalText, matches, region: cand.region });
  }

  return out;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function collectSnippetMatches(snippet: string, terms: readonly SearchTerm[]): SearchHighlight[] {
  const lower = snippet.toLowerCase();
  const matches: SearchHighlight[] = [];
  for (const term of terms) {
    let cursor = 0;
    while (cursor < lower.length) {
      const idx = lower.indexOf(term.value, cursor);
      if (idx === -1) break;
      matches.push({ tokenIndex: term.index, start: idx, length: term.value.length });
      cursor = idx + term.value.length;
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
