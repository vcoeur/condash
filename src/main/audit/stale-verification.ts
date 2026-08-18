/**
 * `stale-verification` audit check — knowledge body files whose
 * `**Verified:** YYYY-MM-DD …` stamp is older than the freshness threshold.
 *
 * The stamp grammar + age arithmetic live in `../knowledge-stamps.ts`; the
 * file enumeration reuses the shared knowledge walker (`collectKnowledgeBodyFiles`,
 * which excludes auto-generated `index.md`). This is the engine behind both
 * `condash knowledge verify` (which adds fresh/unstamped tallies for its
 * envelope) and the GUI audit pane / `condash audit` (which see only the
 * stale issues). A stale stamp is never auto-fixed: it means a human must
 * reread the source and re-confirm, not bump the date.
 */

import { join, relative } from 'node:path';
import { promises as fs } from 'node:fs';
import { collectKnowledgeBodyFiles } from '../search/walk';
import { stampAgeDays, verifiedStampRange, type VerifiedStamp } from '../knowledge-stamps';
import type { AuditIssue } from './shared';

/** Default freshness window in days. Matches the pane chip's "stale" tier
 * (`renderer/panes/knowledge.tsx`), so verify, the audit check, and the pane
 * all agree on what "stale" means. */
export const DEFAULT_STALE_MAX_AGE_DAYS = 90;

/** One stamp of a scan, with its age resolved. */
export interface ScannedStamp {
  /** 1-based line the stamp was found on. */
  line: number;
  /** ISO `YYYY-MM-DD` date on the stamp. */
  verifiedAt: string;
  /** Trailing provenance text after the date. */
  where: string;
  /** Whole-day age of the stamp relative to the scan time. */
  ageDays: number;
}

/**
 * One scanned **file**, described by its oldest stamp.
 *
 * The top-level `line` / `verifiedAt` / `where` / `ageDays` are the *oldest*
 * stamp's — staleness is judged on the oldest claim, so a file is stale as
 * soon as any one of its sections has aged out. `newest` carries the other
 * end of the range so a reader can tell "nothing here has been touched in
 * six months" from "the header is old but section 4 was re-verified last
 * week"; in a single-stamp file the two are identical.
 */
export interface StampScanEntry extends ScannedStamp {
  /** Absolute path of the body file. */
  path: string;
  /** Path relative to the conception root. */
  relPath: string;
  /** The file's latest-dated stamp. */
  newest: ScannedStamp;
  /** How many stamps the file carries. */
  stampCount: number;
}

/** Full result of a stale-stamp scan: stale + fresh stamps and unstamped files. */
export interface StampScanResult {
  /** Stamps older than `maxAgeDays`. */
  stale: StampScanEntry[];
  /** Stamps within the threshold. */
  fresh: StampScanEntry[];
  /** Body files carrying no `**Verified:**` stamp (conception-relative paths). */
  unstamped: string[];
  /** The threshold the scan ran with. */
  maxAgeDays: number;
}

/**
 * Scan every knowledge body file for `**Verified:**` stamps and classify them
 * against `maxAgeDays`. Pure read-only.
 *
 * @param conceptionPath absolute conception root
 * @param maxAgeDays freshness window (default 90)
 * @param today reference date for age (defaults to now — injectable for tests)
 */
export async function scanStaleStamps(
  conceptionPath: string,
  maxAgeDays: number = DEFAULT_STALE_MAX_AGE_DAYS,
  today: Date = new Date(),
): Promise<StampScanResult> {
  const knowledgeRoot = join(conceptionPath, 'knowledge');
  const files = await collectKnowledgeBodyFiles(knowledgeRoot);
  const stale: StampScanEntry[] = [];
  const fresh: StampScanEntry[] = [];
  const unstamped: string[] = [];

  for (const path of files) {
    const raw = await fs.readFile(path, 'utf8');
    const range = verifiedStampRange(raw);
    const relPath = relative(conceptionPath, path);
    if (!range) {
      unstamped.push(relPath);
      continue;
    }
    const entry: StampScanEntry = {
      path,
      relPath,
      ...withAge(range.oldest, today),
      newest: withAge(range.newest, today),
      stampCount: range.count,
    };
    if (entry.ageDays > maxAgeDays) stale.push(entry);
    else fresh.push(entry);
  }
  return { stale, fresh, unstamped, maxAgeDays };
}

/** Resolve a parsed stamp's whole-day age against the scan's reference date. */
function withAge(stamp: VerifiedStamp, today: Date): ScannedStamp {
  return {
    line: stamp.line,
    verifiedAt: stamp.verifiedAt,
    where: stamp.where,
    ageDays: stampAgeDays(stamp.verifiedAt, today),
  };
}

/**
 * Turn the stale entries of a scan into audit issues. `autoFix` is always
 * false — a stale stamp flags a human review, never a mechanical date bump.
 *
 * @param result the scan result
 * @param checkName the `check` label to stamp on each issue. Defaults to the
 *   canonical audit-check name `stale-verification`; the standalone
 *   `knowledge verify` command passes its historical `stale_verification`
 *   (underscore) label to keep its long-standing JSON-envelope contract.
 */
export function staleStampsToIssues(
  result: StampScanResult,
  checkName: string = 'stale-verification',
): AuditIssue[] {
  return result.stale.map((entry) => ({
    check: checkName,
    severity: 'warn' as const,
    file: entry.relPath,
    line: entry.line,
    message: `Verification stamp from ${entry.verifiedAt} (${entry.ageDays}d ago) is older than ${result.maxAgeDays}-day threshold${newestSuffix(entry)}`,
    fix: {
      action: 'flag_for_user_review',
      autoFix: false,
      verifiedAt: entry.verifiedAt,
      ageDays: entry.ageDays,
      where: entry.where,
      newestVerifiedAt: entry.newest.verifiedAt,
      newestLine: entry.newest.line,
      stampCount: entry.stampCount,
    },
  }));
}

/** " — newest of N stamps: DATE (line L)", or empty for a single-stamp file.
 * The stale stamp is the oldest one, so on a sectioned file the message has
 * to say what else is in there — otherwise it reads as though the whole file
 * had gone unread since that date. */
function newestSuffix(entry: StampScanEntry): string {
  if (entry.stampCount < 2) return '';
  return ` — newest of ${entry.stampCount} stamps: ${entry.newest.verifiedAt} (line ${entry.newest.line})`;
}

/**
 * The `stale-verification` audit check entry point. Runs the scan at the
 * default threshold and returns only the stale issues (the audit framework
 * has no per-check options surface, so the freshness window is the default;
 * `knowledge verify --max-age` remains the tunable entry point).
 */
export async function checkStaleVerification(conceptionPath: string): Promise<AuditIssue[]> {
  const result = await scanStaleStamps(conceptionPath, DEFAULT_STALE_MAX_AGE_DAYS);
  return staleStampsToIssues(result);
}
