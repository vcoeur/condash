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
import { toLowerCaseSameLength } from './lowercase';
import { buildRegions } from './regions';
import { scoreOccurrences, type ScorerOccurrence } from './scorer';
import { buildSnippets } from './snippets';

/** Static identity of a searchable file — everything the matcher needs that
 *  isn't the parsed query. Shared by the disk path (`matchFile`) and the
 *  in-memory index (`prepareFile` → `matchPrepared`). */
export interface FileRef {
  path: string;
  relPath: string;
  source: 'project' | 'knowledge' | 'resources' | 'skills' | 'logs';
  projectPath?: string;
}

export interface MatchInput extends FileRef {
  terms: readonly SearchTerm[];
}

export interface MatchOutput {
  hit: SearchHit;
  /** mtime in millis — used as a tie-breaker in the orchestrator's sort. */
  mtimeMs: number;
}

/** A file read + precomputed for matching: the content the matcher scans plus
 *  the derivations that don't depend on the query (lowercased content/path, the
 *  region map, the title, mtime). The in-memory index (`search/index-cache.ts`)
 *  stores these so a query never re-reads or re-lowercases the markdown tree. */
export interface PreparedFile extends FileRef {
  mtimeMs: number;
  /** Post-log-strip content — what snippets quote and titles derive from. */
  raw: string;
  lowerContent: string;
  lowerPath: string;
  regions: ReturnType<typeof buildRegions>;
  title: string;
}

/**
 * Read a file and precompute everything the matcher needs that doesn't depend
 * on the query. Returns `null` on read failure. The query-independent work
 * (read + `toLowerCase` + region map + title) is exactly what the in-memory
 * index caches, so an indexed query skips straight to `matchPrepared`.
 */
export async function prepareFile(ref: FileRef): Promise<PreparedFile | null> {
  let raw: string;
  let mtimeMs: number;
  try {
    const stat = await fs.stat(ref.path);
    mtimeMs = stat.mtimeMs;
    raw = await fs.readFile(ref.path, 'utf8');
    // Logs carry a `# condash: {...}` header / footer line for the
    // session's spawn / exit metadata. Strip those before matching so a
    // search for "exit" doesn't snippet-quote the JSON.
    if (ref.source === 'logs') {
      raw = splitContent(raw).text;
    }
  } catch {
    return null;
  }

  return {
    ...ref,
    mtimeMs,
    raw,
    // Length-preserving lowering: occurrence offsets are computed on the
    // lowered strings but index into `raw` / `relPath` (regions, snippet
    // windows, path highlights), so the lowered form must never drift in
    // length (e.g. U+0130 grows under a plain `toLowerCase()`).
    lowerContent: toLowerCaseSameLength(raw),
    lowerPath: toLowerCaseSameLength(ref.relPath),
    regions: buildRegions(raw, ref.source),
    title: extractFirstHeadingOrLine(raw) ?? ref.relPath,
  };
}

/**
 * Match a prepared file against the parsed query — pure, no I/O. Returns `null`
 * when the file fails the AND filter (some term has no occurrence in either
 * content or path).
 *
 * AND semantics: every term must match somewhere — the body, the path, or
 * any combination. Path-matches alone are enough to surface a file (slug-
 * only hits, e.g. `2026-04-29` matching by date prefix).
 */
export function matchPrepared(
  file: PreparedFile,
  terms: readonly SearchTerm[],
): MatchOutput | null {
  const { lowerContent, lowerPath, regions, raw } = file;
  const occurrences: ScorerOccurrence[] = [];
  const pathMatches: SearchHighlight[] = [];

  for (const term of terms) {
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
  for (const term of terms) {
    if (!matchedTokens.has(term.index)) return null;
  }

  const score = scoreOccurrences(occurrences, terms);
  const matchCount = occurrences.length;
  const snippets = buildSnippets(raw, terms, regions);

  return {
    hit: {
      path: file.path,
      relPath: file.relPath,
      title: file.title,
      source: file.source,
      score,
      matchCount,
      snippets,
      pathMatches: pathMatches.length > 0 ? pathMatches : undefined,
      projectPath: file.projectPath,
    },
    mtimeMs: file.mtimeMs,
  };
}

/**
 * Match a single file against the parsed query, reading it from disk. Returns
 * `null` on read failure or when the file fails the AND filter. Equivalent to
 * `prepareFile` + `matchPrepared`; used for the on-disk path (logs, and the
 * pre-index fallback).
 */
export async function matchFile(input: MatchInput): Promise<MatchOutput | null> {
  const prepared = await prepareFile(input);
  if (!prepared) return null;
  return matchPrepared(prepared, input.terms);
}

/** Best-effort title: returns the first non-empty line with leading
 *  Markdown heading hashes stripped. If the file has no heading, body
 *  text becomes the title — this is intentional so every hit has a
 *  displayable label, but the name is deliberately `…OrLine` to warn
 *  callers that it is not strictly an H1 extractor. */
export function extractFirstHeadingOrLine(raw: string): string | null {
  const limit = Math.min(raw.length, 4096);
  for (const line of raw.slice(0, limit).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '').trim() || null;
  }
  return null;
}
