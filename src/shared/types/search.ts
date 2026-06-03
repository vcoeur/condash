// Global search: parsed query tokens, match highlights and snippets, the
// per-file hit, and the capped result envelope returned by the `search` IPC.

/** One token in the parsed search query. The `index` is the position in the
 * user-typed query, used downstream as the per-token highlight-colour key. */
export interface SearchTerm {
  /** Lowercased token / phrase value. */
  value: string;
  /** True when the user wrote `"two words"` — must match contiguously. */
  phrase: boolean;
  /** 0-based position in the parsed query. */
  index: number;
}

/** Region of a file that produced a match. Used by the scorer for weighting
 * and by the renderer for "where in the file" hints. */
export type SearchRegion = 'h1' | 'meta' | 'heading' | 'body' | 'path';

/** Inline highlight inside a string of text — matched token + offset relative
 * to that string. Used for snippet highlights and path-line highlights. */
export interface SearchHighlight {
  tokenIndex: number;
  start: number;
  length: number;
}

/** A single excerpted snippet from a matched file. */
export interface SearchSnippet {
  text: string;
  /** Inline highlights, offsets relative to `text`. */
  matches: SearchHighlight[];
  region: SearchRegion;
}

export interface SearchHit {
  /** Absolute path of the matched file. */
  path: string;
  /** Path relative to the conception root, for display. */
  relPath: string;
  /** Best-effort title (first H1 line) for display. */
  title: string;
  /** Where the file lives. Drives the result-grouping in the search UI and
   * the per-source facet pills in the search modal. */
  source: 'project' | 'knowledge' | 'resources' | 'skills' | 'logs';
  /** Relevance score — higher is better. */
  score: number;
  /** Total occurrence count across all query terms. */
  matchCount: number;
  /** First few snippets, prioritised by region (meta > h1 > heading > body). */
  snippets: SearchSnippet[];
  /** Highlights into the file path itself, when the path was part of the
   * match — surfaced as a dimmed highlight on the path line. */
  pathMatches?: SearchHighlight[];
  /**
   * Absolute path to the owning project directory when `source === 'project'`.
   * The renderer groups project hits by this field so a project's README +
   * notes/* matches collapse into a single entry — the header opens the
   * project popup, each file row opens the note viewer.
   */
  projectPath?: string;
}

export interface SearchResults {
  hits: SearchHit[];
  /** Tokens parsed from the query, in user-typed order. The renderer uses
   * these for client-side multi-token highlighting. */
  terms: SearchTerm[];
  /** Total matched files before the cap was applied. */
  totalBeforeCap: number;
  /** True when results were truncated to the cap. */
  truncated: boolean;
}
