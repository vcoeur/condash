import { promises as fs } from 'node:fs';
import type { SearchHighlight, SearchHit, SearchTerm } from '../../shared/types';
import { buildRegions } from './regions';
import { scoreOccurrences, type ScorerOccurrence } from './scorer';
import { buildSnippets } from './snippets';

export interface MatchInput {
  path: string;
  relPath: string;
  source: 'project' | 'knowledge';
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
  const title = extractFirstHeading(raw) ?? input.relPath;
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

function extractFirstHeading(raw: string): string | null {
  const limit = Math.min(raw.length, 4096);
  for (const line of raw.slice(0, limit).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '').trim() || null;
  }
  return null;
}
