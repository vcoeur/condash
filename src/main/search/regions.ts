import type { SearchRegion } from '../../shared/types';

const META_LINE = /^\*\*[A-Za-z][\w -]*\*\*\s*:.*$/;
const HEADING = /^#{1,6}\s+/;

/**
 * Build a fast lookup `offset → SearchRegion` for a markdown source. Lines
 * are classified once on construction; lookups are an O(log n) binary search
 * by offset.
 *
 * Region rules:
 * - `h1`: the first H1 line (`# Title`).
 * - `meta`: contiguous `**Field**:` lines after the H1, only for project
 *   sources. Blank lines are kept inside the meta block so the run from H1
 *   to the first non-meta non-blank line is fully tagged.
 * - `heading`: any other `#`-prefixed line.
 * - `body`: everything else.
 *
 * `path` is used for path-line matches and never appears here — the matcher
 * synthesises it directly.
 */
export interface RegionLookup {
  /** Region of the line containing `offset`. */
  regionAt(offset: number): SearchRegion;
  /** Range of the meta block if any was detected — `null` otherwise. Used by
   * the snippet builder to emit a single "headline" snippet for meta hits. */
  metaRange: { start: number; end: number } | null;
}

interface Line {
  start: number;
  end: number;
  region: SearchRegion;
}

export function buildRegions(raw: string, source: 'project' | 'knowledge'): RegionLookup {
  const lines: Line[] = [];
  let pos = 0;
  for (const line of raw.split('\n')) {
    lines.push({ start: pos, end: pos + line.length, region: 'body' });
    pos += line.length + 1;
  }

  let firstH1Set = false;
  let inMeta = false;
  let metaStart: number | null = null;
  let metaEnd: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = raw.slice(lines[i].start, lines[i].end).trim();

    if (!firstH1Set && /^#\s+\S/.test(text)) {
      lines[i].region = 'h1';
      firstH1Set = true;
      if (source === 'project') {
        inMeta = true;
        metaStart = lines[i].start;
        metaEnd = lines[i].end;
      }
      continue;
    }

    if (inMeta) {
      if (text.length === 0 || META_LINE.test(text)) {
        lines[i].region = 'meta';
        metaEnd = lines[i].end;
        continue;
      }
      // First non-meta non-blank line ends the meta block.
      inMeta = false;
    }

    if (HEADING.test(text)) {
      lines[i].region = 'heading';
    }
  }

  return {
    regionAt(offset: number): SearchRegion {
      let lo = 0;
      let hi = lines.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const ln = lines[mid];
        if (offset < ln.start) hi = mid - 1;
        else if (offset > ln.end) lo = mid + 1;
        else return ln.region;
      }
      return 'body';
    },
    metaRange: metaStart !== null && metaEnd !== null ? { start: metaStart, end: metaEnd } : null,
  };
}
