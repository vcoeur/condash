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
 */

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

/**
 * Parse the first `**Verified:**` stamp out of a file's raw text.
 *
 * @param raw the whole file contents
 * @returns the stamp (date + provenance + 1-based line), or `null` when the
 *   file carries no stamp.
 */
export function parseVerifiedStamp(raw: string): VerifiedStamp | null {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = VERIFIED_RE.exec(lines[i]);
    if (match) {
      return { verifiedAt: match[1], where: match[2].trim(), line: i + 1 };
    }
  }
  return null;
}

/**
 * Parse just the date out of the first `**Verified:**` stamp. Convenience for
 * the card/bullet readers that only need the date, not the provenance or line.
 *
 * @param head the head of a file (the readers read a bounded prefix)
 * @returns the ISO date, or `undefined` when no stamp is present.
 */
export function parseVerifiedDate(head: string): string | undefined {
  return parseVerifiedStamp(head)?.verifiedAt ?? undefined;
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
