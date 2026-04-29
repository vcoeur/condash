import type { SearchRegion, SearchTerm } from '../../shared/types';

/**
 * Per-occurrence score weights. Tweakable centrally — every region weight
 * lives in one place so the relative ranking is easy to read.
 *
 * Rationale:
 * - `h1` (title) dominates — a hit in the project's H1 is the strongest
 *   "this is what the file is about" signal we have.
 * - `meta` (frontmatter) is high because `**Apps**: condash` is intent-
 *   bearing — the user typed "condash" wanting projects tagged condash.
 * - `heading` is moderate.
 * - `path` floors at 5 so a slug-only match (no body hits) still ranks.
 * - `body` is 1 — the count adds up but never out-shouts a title hit.
 */
const REGION_WEIGHT: Record<SearchRegion, number> = {
  h1: 20,
  meta: 15,
  heading: 5,
  path: 5,
  body: 1,
};

/** Bonus when a phrase term matched anywhere — phrases imply adjacency, so
 * they're worth a little extra over a bare token. */
const PHRASE_BONUS = 5;

/** Bonus when any two distinct token types appear within ADJACENCY_RADIUS
 * chars of each other, applied at most once per file. */
const ADJACENCY_RADIUS = 30;
const ADJACENCY_BONUS = 10;

export interface ScorerOccurrence {
  tokenIndex: number;
  offset: number;
  region: SearchRegion;
}

/**
 * Score a hit from its occurrences and the parsed query. Pure function —
 * trivial to extend (add new region weights, new bonuses) and trivial to
 * unit-test.
 */
export function scoreOccurrences(
  occurrences: readonly ScorerOccurrence[],
  terms: readonly SearchTerm[],
): number {
  let score = 0;

  for (const occ of occurrences) {
    score += REGION_WEIGHT[occ.region];
  }

  const matchedTokens = new Set<number>();
  for (const occ of occurrences) matchedTokens.add(occ.tokenIndex);

  for (const term of terms) {
    if (term.phrase && matchedTokens.has(term.index)) {
      score += PHRASE_BONUS;
    }
  }

  if (matchedTokens.size >= 2) {
    score += adjacencyBonus(occurrences);
  }

  return score;
}

function adjacencyBonus(occurrences: readonly ScorerOccurrence[]): number {
  // Group occurrences by token index, ignoring path-region hits (the path
  // string is too short to make adjacency meaningful).
  const byToken = new Map<number, number[]>();
  for (const occ of occurrences) {
    if (occ.region === 'path') continue;
    const list = byToken.get(occ.tokenIndex) ?? [];
    list.push(occ.offset);
    byToken.set(occ.tokenIndex, list);
  }

  if (byToken.size < 2) return 0;

  const indices = [...byToken.keys()];
  for (let i = 0; i < indices.length; i++) {
    const offsetsA = byToken.get(indices[i])!;
    for (let j = i + 1; j < indices.length; j++) {
      const offsetsB = byToken.get(indices[j])!;
      for (const a of offsetsA) {
        for (const b of offsetsB) {
          if (Math.abs(a - b) <= ADJACENCY_RADIUS) return ADJACENCY_BONUS;
        }
      }
    }
  }
  return 0;
}
