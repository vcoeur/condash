/**
 * Heading-delimited region helpers for top-level files (AGENTS.md, .gitignore).
 *
 * A region is the body of a markdown H2 (or gitignore-style `#`) section,
 * identified by its heading text. `extractRegion` returns the body between
 * the heading line (exclusive) and the next sibling heading (exclusive) or
 * end-of-file; `replaceRegion` swaps that body while preserving everything
 * outside. Both refuse when the heading is missing or appears more than
 * once, leaving the file untouched.
 *
 * Pure module — no I/O. Used by the file-region branch of
 * `condash skills install` (see `files.ts`) and exercised directly by
 * `regions.test.ts`.
 */

/** Default heading mark — markdown H2 (`##`). */
export const DEFAULT_MARK = '##';

/** Options threaded into findHeading; defaults to markdown H2 with no sibling list. */
export interface HeadingOpts {
  /**
   * Heading prefix without trailing whitespace. Default '##' (markdown H2 —
   * used by AGENTS.md). For gitignore-style files use '#'.
   */
  mark?: string;
  /**
   * Fixed sibling section names that end this region's body. When set, the
   * "next heading" regex matches *only* these names — required for gitignore-
   * style files where every comment line shares the mark with section
   * headings. When unset, any line starting with `mark` ends the region
   * (markdown H2 behaviour).
   */
  siblings?: string[];
}

/**
 * Extract the body of a section identified by its heading text.
 *
 * Default (no `opts`) is markdown H2: region body is everything between
 * `## <region>` (exclusive) and the next `## …` (exclusive) or end-of-file.
 *
 * With `opts.mark = '#'` and `opts.siblings = [...]`, parses gitignore-style
 * sections: region body runs between `# <region>` and the next line matching
 * `# <one-of-siblings>` (exclusive) or end-of-file. The fixed sibling list
 * is required because every gitignore comment line starts with `#` — a
 * generic "any heading at this level" stop would match user comments.
 *
 * The heading line itself and any trailing blank line before the next
 * heading are not part of the body — they are structural and would otherwise
 * leak into the hash.
 *
 * Returns `null` when the heading is missing or appears more than once
 * (ambiguous) — both cases are treated as `missing-heading` upstream so the
 * user is asked rather than silently overwritten.
 *
 * The match is case- and whitespace-sensitive on the heading text itself.
 * For markdown mode, H3+ (`### …`) never match: the regex demands exactly
 * two `#`.
 */
export function extractRegion(
  content: string,
  region: string,
  opts: HeadingOpts = {},
): string | null {
  const heading = findHeading(content, region, opts);
  if (heading === null) return null;
  return content.slice(heading.bodyStart, heading.bodyEnd);
}

/**
 * Replace the body of the section identified by `region`, preserving the
 * heading line and everything outside the region. Throws when the heading is
 * missing or ambiguous; callers should use `extractRegion` first to gate.
 */
export function replaceRegion(
  content: string,
  region: string,
  replacement: string,
  opts: HeadingOpts = {},
): string {
  const heading = findHeading(content, region, opts);
  if (heading === null) {
    throw new Error(`Region ${region} not found in content`);
  }
  const before = content.slice(0, heading.bodyStart);
  const after = content.slice(heading.tailStart);
  if (after.length === 0) {
    // Heading runs to EOF — trail the new body with one newline so the file
    // ends cleanly.
    return `${before}${replacement}\n`;
  }
  // A blank line separates the body from the next heading. We always emit
  // one, normalising whatever the user had before.
  return `${before}${replacement}\n\n${after}`;
}

interface HeadingSpan {
  /** Index of the first byte of the body content (after the heading line). */
  bodyStart: number;
  /** Index of the last byte + 1 of the body content (after trimming the
   *  trailing newlines that separate body from next heading or EOF). Used
   *  for hashing and extraction. */
  bodyEnd: number;
  /** Index of the start of the tail region — i.e. the next sibling heading
   *  or EOF. Used by `replaceRegion` so the trailing newlines don't get
   *  duplicated. */
  tailStart: number;
}

function findHeading(content: string, region: string, opts: HeadingOpts): HeadingSpan | null {
  const mark = opts.mark ?? DEFAULT_MARK;
  const headingRe = new RegExp(`^${escapeRegex(mark)}[ \\t]+${escapeRegex(region)}[ \\t]*$`, 'gm');
  const matches = [...content.matchAll(headingRe)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const headingStart = match.index!;
  const headingEnd = headingStart + match[0].length;
  // Body starts on the line after the heading; skip exactly one '\n'.
  let bodyStart = headingEnd;
  if (content[bodyStart] === '\n') bodyStart += 1;

  // Next-heading regex. With siblings, match only those names — the fixed
  // list is what makes gitignore parsing safe (every comment shares `#`).
  // Without siblings, fall back to the markdown lookahead: any line starting
  // with the mark followed by space/tab is a sibling heading (H3+ excluded
  // because the lookahead demands whitespace immediately after the mark).
  const nextRe = opts.siblings
    ? new RegExp(
        `^${escapeRegex(mark)}[ \\t]+(?:${opts.siblings.map(escapeRegex).join('|')})[ \\t]*$`,
        'gm',
      )
    : new RegExp(`^${escapeRegex(mark)}(?=[ \\t])`, 'gm');
  nextRe.lastIndex = bodyStart;
  const next = nextRe.exec(content);
  const tailStart = next ? next.index : content.length;
  // Trim trailing newlines so the hash is stable when the user adds or
  // removes blank lines before the next heading.
  let bodyEnd = tailStart;
  while (bodyEnd > bodyStart && content[bodyEnd - 1] === '\n') bodyEnd -= 1;
  return { bodyStart, bodyEnd, tailStart };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
