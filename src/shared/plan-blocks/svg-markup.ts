/**
 * String-level helpers for `svg` block markup, shared by the parser (which
 * has no DOM — `condash mdx check` runs in Node) and the renderer's sanitizer
 * / standalone-file builder. One list of what the viewer strips, one scanner
 * for the root start tag, so the check verb and the viewer cannot disagree.
 */

/**
 * Elements the svg sanitizer drops, beyond what DOMPurify's SVG profile
 * already refuses. The sanitizer spreads these (lowercased, as DOMPurify
 * keys) into FORBID_TAGS; `svgPayloadIssues` warns on each before the block
 * renders without it. Casing here is the author-facing one for messages.
 */
export const SVG_STRIPPED_ELEMENTS = [
  'script',
  'foreignObject',
  'style',
  'use',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
] as const;

/**
 * Skip the non-element head tool exports carry — an XML prolog, a DOCTYPE,
 * comments, whitespace — and return the offset of the first `<` that starts
 * an element, or -1. A pasted Inkscape / draw.io file then passes the root
 * test on its `<svg>`, exactly as the HTML parser behind the sanitizer
 * treats it (the prolog is dropped).
 */
function firstElementOffset(markup: string): number {
  let i = 0;
  while (i < markup.length) {
    const rest = markup.slice(i);
    const lead = rest.match(/^\s+/);
    if (lead) {
      i += lead[0].length;
      continue;
    }
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end < 0) return -1;
      i += end + 2;
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) return -1;
      i += end + 3;
      continue;
    }
    if (rest.startsWith('<!')) {
      // A DOCTYPE may carry an internal subset `[ … ]` whose declarations
      // contain `>` themselves; the construct then ends at `]>`.
      const bracket = rest.indexOf('[');
      const plainEnd = rest.indexOf('>');
      const end = bracket >= 0 && bracket < plainEnd ? rest.indexOf(']>', bracket) + 1 : plainEnd;
      if (end < 1) return -1;
      i += end + 1;
      continue;
    }
    return rest.startsWith('<') ? i : -1;
  }
  return -1;
}

/**
 * The root `<svg …>` start tag of `markup` (after any prolog), or null when
 * the first element is not `<svg>`. Quotes are honoured, so a `>` inside an
 * attribute value — `aria-label="A -> B"` — does not end the tag the way a
 * `[^>]*` regex would. Returns the tag text and the offsets that frame it.
 */
export function svgRootTag(markup: string): { tag: string; start: number; end: number } | null {
  const start = firstElementOffset(markup);
  if (start < 0 || !/^<svg[\s>/]/i.test(markup.slice(start, start + 5))) return null;
  let quote: string | null = null;
  for (let i = start + 4; i < markup.length; i += 1) {
    const ch = markup[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { tag: markup.slice(start, i + 1), start, end: i + 1 };
    }
  }
  return null;
}

/** Case-insensitive "does the markup contain an element named `name`" test —
 *  `<animate ` matches, `<animateTransform ` does not match `animate`. */
export function containsElement(markup: string, name: string): boolean {
  return new RegExp(`<${name}[\\s>/]`, 'i').test(markup);
}
