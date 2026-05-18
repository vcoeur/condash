/**
 * Per-file matcher. For each candidate file:
 *   1. Read + lowercase the content, build the region map (h1/meta/heading/body).
 *   2. For each term, scan both content + relPath, recording every occurrence
 *      with its region tag. Drop the file if any term has zero hits — AND
 *      semantics across the query.
 *   3. Hand the occurrences to `scorer.scoreOccurrences` for ranking — see
 *      `./scorer.ts` for the region-weight table and bonus rationale (h1
 *      dominates, path floors at 5 so slug-only hits still surface, phrase
 *      and adjacency bonuses promote tighter matches).
 *   4. Build snippets via `./snippets.ts` for the renderer's hit preview.
 *
 * Scoring rationale stays in `scorer.ts` so a future tweak of the weights
 * only needs to touch one file — this module just plumbs occurrences in.
 */
import { promises as fs } from 'node:fs';
import type { SearchHighlight, SearchHit, SearchTerm } from '../../shared/types';
import { splitContent } from '../logs-format';
import { buildRegions } from './regions';
import { scoreOccurrences, type ScorerOccurrence } from './scorer';
import { buildSnippets } from './snippets';

export interface MatchInput {
  path: string;
  relPath: string;
  source: 'project' | 'knowledge' | 'resources' | 'skills' | 'logs';
  projectPath?: string;
  terms: readonly SearchTerm[];
}

export interface MatchOutput {
  hit: SearchHit;
  /** mtime in millis — used as a tie-breaker in the orchestrator's sort. */
  mtimeMs: number;
}

/**
 * Match a single file against the parsed query. Returns `null` when the file
 * fails the AND filter (some term has no occurrence in either content or
 * path), or on read failure.
 *
 * AND semantics: every term must match somewhere — the body, the path, or
 * any combination. Path-matches alone are enough to surface a file (slug-
 * only hits, e.g. `2026-04-29` matching by date prefix).
 */
export async function matchFile(input: MatchInput): Promise<MatchOutput | null> {
  let raw: string;
  let mtimeMs: number;
  try {
    const stat = await fs.stat(input.path);
    mtimeMs = stat.mtimeMs;
    raw = await fs.readFile(input.path, 'utf8');
    // Logs carry a `# condash: {...}` header / footer line for the
    // session's spawn / exit metadata. Strip those before matching so a
    // search for "exit" doesn't snippet-quote the JSON.
    if (input.source === 'logs') {
      raw = splitContent(raw).text;
    }
  } catch {
    return null;
  }

  const lowerContent = raw.toLowerCase();
  const lowerPath = input.relPath.toLowerCase();
  const regions = buildRegions(raw, input.source);

  const occurrences: ScorerOccurrence[] = [];
  const pathMatches: SearchHighlight[] = [];

  for (const term of input.terms) {
    let cursor = 0;
    while (cursor < lowerContent.length) {
      const idx = lowerContent.indexOf(term.value, cursor);
      if (idx === -1) break;
      occurrences.push({
        tokenIndex: term.index,
        offset: idx,
        region: regions.regionAt(idx),
      });
      cursor = idx + term.value.length;
    }

    cursor = 0;
    while (cursor < lowerPath.length) {
      const idx = lowerPath.indexOf(term.value, cursor);
      if (idx === -1) break;
      pathMatches.push({
        tokenIndex: term.index,
        start: idx,
        length: term.value.length,
      });
      occurrences.push({
        tokenIndex: term.index,
        offset: idx,
        region: 'path',
      });
      cursor = idx + term.value.length;
    }
  }

  const matchedTokens = new Set(occurrences.map((o) => o.tokenIndex));
  for (const term of input.terms) {
    if (!matchedTokens.has(term.index)) return null;
  }

  const score = scoreOccurrences(occurrences, input.terms);
  const matchCount = occurrences.length;
  const title = extractFirstHeadingOrLine(raw) ?? input.relPath;
  const snippets = buildSnippets(raw, input.terms, regions);

  return {
    hit: {
      path: input.path,
      relPath: input.relPath,
      title,
      source: input.source,
      score,
      matchCount,
      snippets,
      pathMatches: pathMatches.length > 0 ? pathMatches : undefined,
      projectPath: input.projectPath,
    },
    mtimeMs,
  };
}

/** Best-effort title: returns the first non-empty line with leading
 *  Markdown heading hashes stripped. If the file has no heading, body
 *  text becomes the title — this is intentional so every hit has a
 *  displayable label, but the name is deliberately `…OrLine` to warn
 *  callers that it is not strictly an H1 extractor. */
function extractFirstHeadingOrLine(raw: string): string | null {
  const limit = Math.min(raw.length, 4096);
  for (const line of raw.slice(0, limit).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '').trim() || null;
  }
  return null;
}
