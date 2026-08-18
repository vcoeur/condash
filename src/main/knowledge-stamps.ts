/**
 * Single source of truth for the `**Verified:** YYYY-MM-DD …` stamp that
 * marks when a knowledge body file was last re-confirmed against its source.
 *
 * The regex and the stale-age arithmetic used to be re-implemented in three
 * places — `main/knowledge.ts` (card metadata), `main/index-knowledge.ts`
 * (index bullets), and the `knowledge verify` CLI command. They now all flow
 * through this module so the stamp grammar never drifts, and the
 * `stale-verification` audit check (`audit/stale-verification.ts`) gets the
 * same scan the CLI exposes — surfacing stale stamps in the GUI audit pane
 * and `condash audit` rather than only via the standalone `knowledge verify`.
 *
 * A file may carry **more than one** stamp: the convention recommends one per
 * section when sections are verified on different dates. Every reader here
 * therefore scans the whole file and reduces to a {@link VerifiedStampRange},
 * because reading only the first stamp got staleness wrong in both directions
 * — an old header stamp hid a freshly re-verified section, and a fresh header
 * stamp hid a genuinely aged claim further down (condash#512).
 */

import { iterUnfencedLines } from '../shared/header';

/**
 * Match a `**Verified:**` stamp line, capturing the ISO date and the trailing
 * provenance ("where") text. Anchored to the start of a trimmed line. The
 * `where` group is greedy-to-end and may be empty.
 */
const VERIFIED_RE = /^\*\*Verified:\*\*\s+(\d{4}-\d{2}-\d{2})\b\s*(.*)$/;

/** A `**Verified:**` line with no date (or anything before the date). Used by
 * the stamp writer to find and replace an existing stamp regardless of date. */
export const VERIFIED_PREFIX_RE = /^\*\*Verified:\*\*/;

/** A parsed `**Verified:**` stamp: its date, provenance text, and 1-based line. */
export interface VerifiedStamp {
  /** ISO `YYYY-MM-DD` date the file was last verified. */
  verifiedAt: string;
  /** Trailing provenance text after the date (e.g. `condash@abc1234 on main`). */
  where: string;
  /** 1-based line number the stamp was found on. */
  line: number;
}

/**
 * Match a single line as a `**Verified:**` stamp, returning its date when it
 * is one. The line is matched as-is (callers that scan trimmed lines pass the
 * trimmed value). Used by the fence-aware head parser, which needs per-line
 * control rather than a whole-file scan.
 *
 * @param line one line of text
 * @returns the ISO date when the line is a stamp, else `null`.
 */
export function matchVerifiedLine(line: string): string | null {
  const match = VERIFIED_RE.exec(line);
  return match ? match[1] : null;
}

/** Every stamp in a file, reduced to the two that matter for staleness. */
export interface VerifiedStampRange {
  /** The earliest-dated stamp — the one staleness is judged on. */
  oldest: VerifiedStamp;
  /** The latest-dated stamp. Equals {@link oldest} in a single-stamp file. */
  newest: VerifiedStamp;
  /** How many stamps the file carries. */
  count: number;
}

/**
 * Parse every `**Verified:**` stamp out of a file's raw text, in source
 * order. Fence-aware: a stamp shown as an example inside a fenced code block
 * documents the grammar, it does not claim a verification date.
 *
 * @param raw the whole file contents
 * @returns one entry per stamp (date + provenance + 1-based line); empty when
 *   the file carries none.
 */
export function parseVerifiedStamps(raw: string): VerifiedStamp[] {
  const stamps: VerifiedStamp[] = [];
  for (const { index, line } of iterUnfencedLines(raw.split(/\r?\n/))) {
    const match = VERIFIED_RE.exec(line);
    if (match) {
      stamps.push({ verifiedAt: match[1], where: match[2].trim(), line: index + 1 });
    }
  }
  return stamps;
}

/**
 * Reduce a file's stamps to its oldest and newest. Dates are ISO, so a string
 * compare is a chronological one; ties are broken by source order, so
 * `oldest` is the first stamp of the earliest date and `newest` the last
 * stamp of the latest date.
 *
 * @param raw the whole file contents
 * @returns the range, or `null` when the file carries no stamp.
 */
export function verifiedStampRange(raw: string): VerifiedStampRange | null {
  const stamps = parseVerifiedStamps(raw);
  if (stamps.length === 0) return null;
  let oldest = stamps[0];
  let newest = stamps[0];
  for (const stamp of stamps.slice(1)) {
    if (stamp.verifiedAt < oldest.verifiedAt) oldest = stamp;
    if (stamp.verifiedAt >= newest.verifiedAt) newest = stamp;
  }
  return { oldest, newest, count: stamps.length };
}

/**
 * Whole-day age of an ISO `YYYY-MM-DD` stamp relative to `today`, in local
 * calendar days. Stamps are written with the local-time `isoToday`, so "now"
 * must use the *local* date parts of `today` — a `getUTC*` reading was off
 * by one around midnight on any machine not on UTC. Floors to whole days
 * and never returns a negative number (a future-dated stamp reads as 0
 * days old).
 *
 * @param iso the stamp date as `YYYY-MM-DD`
 * @param today the reference date (defaults to now)
 */
export function stampAgeDays(iso: string, today: Date = new Date()): number {
  const [year, month, day] = iso.split('-').map(Number);
  const stamp = Date.UTC(year, month - 1, day);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.floor((now - stamp) / (1000 * 60 * 60 * 24)));
}
