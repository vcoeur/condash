import { promises as fs } from 'node:fs';
import { relative } from 'node:path';
import { toPosix } from '../../shared/path';
import { collectKnowledgeBodyFiles } from './walk';

/** One matching line in a knowledge body file. */
export interface KnowledgeGrepMatch {
  path: string;
  relPath: string;
  line: number;
  snippet: string;
  /**
   * Relevance: each matched token weighted by how rare it is across the tree,
   * summed, plus a bonus when the whole phrase is on the line.
   *
   * Not a count of tokens — a line carrying one distinctive term outranks one
   * carrying two that appear everywhere, which is the whole point of the
   * weighting. Comparable within one query's results and meaningless between
   * queries.
   */
  score: number;
}

/** Longest snippet returned per match, so a wide line cannot flood the output. */
const SNIPPET_LIMIT = 200;

/**
 * How much a token contributes, given how many files carry it.
 *
 * Weighting rather than excluding: a share-based cut-off has a cliff on a small
 * tree, where the only file holding a token reads as "in 100% of the corpus" and
 * the one useful term gets dropped. Weighting degrades smoothly — a term in
 * every file still matches, it just cannot outrank a rare one.
 */
function tokenWeight(fileHits: number): number {
  return 1 / Math.log2(2 + fileHits);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tokens at or below this length are matched whole; longer ones are truncated. */
const STEM_LENGTH = 6;

/**
 * Reduce a query token to a prefix, so a reader's word finds the tree's word.
 *
 * Nobody searches in the inflection the author happened to write. `dismissal`
 * does not substring-match `dismissed`, and `regressions` does not match
 * `regression` — a query phrased in ordinary English misses a document that is
 * about exactly that, which defeats the point of full-text search. A prefix is
 * a cruder stemmer than a real one and a much smaller thing to maintain.
 */
function stem(token: string): string {
  return token.length > STEM_LENGTH ? token.slice(0, STEM_LENGTH) : token;
}

/**
 * Full-text search over the knowledge body files, one query token at a time.
 *
 * Tokenising matters more than it looks. Matching the whole query as a single
 * literal phrase means any multi-word question finds nothing at all — and when
 * grep is only reached as a fallback from a triage layer that scored one
 * spurious keyword, neither layer answers. Both halves of that were live, and
 * together they are why a file naming a bug's exact mechanism went unread the
 * day after it was written.
 *
 * @param knowledgeRoot Absolute path to the conception's `knowledge/` directory.
 * @param conceptionPath Absolute path to the conception root, for relative paths.
 * @param query Raw user query; split on whitespace into tokens.
 * @param limit Maximum matches to return; omit for all of them.
 * @returns Matching lines, highest score first.
 */
export async function grepKnowledgeBodies(
  knowledgeRoot: string,
  conceptionPath: string,
  query: string,
  limit?: number,
): Promise<KnowledgeGrepMatch[]> {
  const tokens = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (tokens.length === 0) return [];

  const files = await collectKnowledgeBodyFiles(knowledgeRoot);
  const contents = new Map<string, string[]>();
  for (const path of files) {
    contents.set(path, (await fs.readFile(path, 'utf8')).split(/\r?\n/));
  }

  // Weight each token by how rare it is across the tree, so a line carrying the
  // one distinctive term of a query outranks one carrying only its filler.
  const weighted = tokens.map((token) => {
    const re = new RegExp(escapeRegex(stem(token)), 'i');
    const fileHits = [...contents.values()].filter((lines) => lines.some((l) => re.test(l))).length;
    return { re, weight: tokenWeight(fileHits) };
  });

  const phrase = new RegExp(escapeRegex(query), 'i');
  const matches: KnowledgeGrepMatch[] = [];
  for (const [path, lines] of contents) {
    for (let i = 0; i < lines.length; i++) {
      const hit = weighted.filter(({ re }) => re.test(lines[i]));
      if (hit.length === 0) continue;
      const tokenScore = hit.reduce((sum, { weight }) => sum + weight, 0);
      matches.push({
        path,
        relPath: toPosix(relative(conceptionPath, path)),
        line: i + 1,
        snippet: lines[i].slice(0, SNIPPET_LIMIT),
        // The phrase bonus clears any achievable token total, so an exact hit leads.
        score: tokenScore + (phrase.test(lines[i]) ? tokens.length : 0),
      });
    }
  }
  matches.sort(
    (a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath) || a.line - b.line,
  );
  return limit === undefined ? matches : matches.slice(0, limit);
}
