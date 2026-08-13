/**
 * Tag-quality filter for the knowledge / projects index regenerator.
 *
 * Applied at three points (see issue #79):
 *  - End of `deriveFileKeywords` — replaces the bare `length < 3` check.
 *  - Beginning of subdir-bullet aggregation — before merging additions into a parent.
 *  - End of `aggregatedKeywords` build — before the parent's pass sees descendant tags.
 *
 * The filter is deliberately conservative: we only reject mechanically detectable
 * junk (length, pure numeric, date-shaped, UUID-shaped, leading/trailing-hyphen,
 * numeric-hyphen shapes, hex literals, measurements, English stop-words). We do
 * NOT try to detect semantically weak tags. Borderline-but-real tags survive and
 * surface via the over-target report.
 */

const MIN_LENGTH = 3;
const MAX_LENGTH = 40;

const PURE_NUMERIC_RE = /^\d+$/;
// ISO date: YYYY-MM or YYYY-MM-DD, zero-padded.
const ISO_DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;
// UUID v1-5 with or without dashes.
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
// Leading or trailing hyphen: `-light`, `data-`, CLI flags `--run` — the
// slugifier keeps hyphens, so `{slug}-light.png` and `data-*` braces fragments
// surface exactly like this.
const LEADING_TRAILING_HYPHEN_RE = /^-|-$/;
// Date-prefixed identifier: `2026-0405a`, `2026-07-22-nodum-phase0-...`.
// (ISO_DATE_RE already handles the pure date; this catches a suffix.)
const DATED_SLUG_RE = /^\d{4}-\d{2,3}[-a-z0-9]*$/;
// Numeric range: `65-89`.
const NUMERIC_RANGE_RE = /^\d+-\d+$/;
// Numeric-prefixed word: `4-test`. Acceptable over-rejection: `2-factor`.
const NUMERIC_PREFIXED_WORD_RE = /^\d+-[a-z]/;
// Hex literal: `0x00`.
const HEX_RE = /^0x[0-9a-f]+$/;
// Measurement: `66ms`, `3.5gb`.
const MEASUREMENT_RE =
  /^\d+(\.\d+)?(ms|kb|mb|gb|tb|px|pt|em|rem|vh|vw|hz|khz|mhz|ghz|dpi|ppi|fps)$/;

const STOP_WORDS = new Set<string>([
  // Pronouns / determiners / common English particles likely to appear as
  // single-token tags via H2/H3 slugify.
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'these',
  'those',
  'from',
  'into',
  'onto',
  'over',
  'under',
  'about',
  'are',
  'was',
  'were',
  'has',
  'had',
  'have',
  'will',
  'would',
  'should',
  'could',
  'when',
  'where',
  'what',
  'why',
  'how',
  'who',
  'whom',
  'whose',
  'all',
  'any',
  'each',
  'every',
  'some',
  'most',
  'more',
  'less',
  'few',
  'not',
  'yes',
  'one',
  'two',
  'three',
  // Content-free verbs / nouns that frequently appear as standalone H2 headings
  // ("## Develop", "## Summary", "## Notes") and slugify to a single junk token.
  'develop',
  'developed',
  'developing',
  'observe',
  'observed',
  'observation',
  'observations',
  'configure',
  'configured',
  'configuration',
  'implement',
  'implemented',
  'implementation',
  'summary',
  'summaries',
  'overview',
  'overviews',
  'note',
  'notes',
  'todo',
  'todos',
  'update',
  'updates',
  'updated',
  'change',
  'changes',
  'changed',
  'fix',
  'fixes',
  'fixed',
  'add',
  'adds',
  'added',
  'remove',
  'removes',
  'removed',
  'use',
  'uses',
  'used',
  'using',
  'run',
  'runs',
  'running',
  'context',
  'goal',
  'goals',
  'scope',
  'steps',
  'step',
  'description',
  'details',
  'rationale',
  // Code keywords surfacing via inline code spans mined verbatim as tags.
  'undefined',
  'false',
  'null',
  'true',
  'import',
  'export',
  'const',
  'let',
  'var',
  'return',
  'function',
  'async',
  'await',
  'typeof',
  'instanceof',
  'void',
  'delete',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'this',
  'extends',
  'new',
  'try',
  'catch',
  'throw',
  'class',
  // Path fragments from inline path code spans (…/.venv/lib/…).
  'usr',
  'bin',
  'lib',
  'src',
  'tmp',
  'venv',
  'python3',
  'site-packages',
  'node_modules',
  'proc',
  'sys',
  // English common words observed as junk on drafted rows.
  'comes',
  'goes',
  'intent',
  'wrong',
  'actually',
  'catches',
  'rather',
  'than',
  'which',
  'guaranteed',
  'installed',
  'after',
  'high',
  'related',
  'kill',
  'bites',
  'quietly',
  'both',
  'levels',
  'guard',
  'survives',
  'real',
  'examples',
  'offers',
  'price',
  'templates',
  'detail',
  'allow',
  'hash',
  'min',
  'url',
  'img',
  'video',
  'web',
  'views',
  'make',
  'test',
  'shape',
  'user',
  'case',
  'rule',
  'read',
  'edit',
  'whole',
  'gone',
  'check',
  'holds',
  'before',
  'worth',
  'separate',
  'finding',
  'adjacent',
  'trap',
  'attribution',
  'fails',
  'applied',
  'principle',
  'regex',
  'setpath',
  'rendered',
]);

/**
 * Returns true if the tag should be rejected as low-quality.
 * Tag comparison is case-insensitive for stop-words; everything else matches the raw form.
 */
export function isLowQualityTag(tag: string): boolean {
  if (tag.length < MIN_LENGTH) return true;
  if (tag.length > MAX_LENGTH) return true;
  if (PURE_NUMERIC_RE.test(tag)) return true;
  if (ISO_DATE_RE.test(tag)) return true;
  if (UUID_RE.test(tag)) return true;
  if (LEADING_TRAILING_HYPHEN_RE.test(tag)) return true;
  if (DATED_SLUG_RE.test(tag)) return true;
  if (NUMERIC_RANGE_RE.test(tag)) return true;
  if (NUMERIC_PREFIXED_WORD_RE.test(tag)) return true;
  if (HEX_RE.test(tag)) return true;
  if (MEASUREMENT_RE.test(tag)) return true;
  if (STOP_WORDS.has(tag.toLowerCase())) return true;
  return false;
}

/**
 * Applies `isLowQualityTag` to a tag list, preserving first-seen order and deduplicating
 * by exact match. Used by callers that own a candidate list and want clean output.
 */
export function filterTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    if (isLowQualityTag(tag)) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}
