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
import { parseVerifiedStamp, stampAgeDays } from '../knowledge-stamps';
import type { AuditIssue } from './shared';

/** Default freshness window in days. Matches the historical CLI default. */
export const DEFAULT_STALE_MAX_AGE_DAYS = 30;

/** One scanned stamp: its file, date, provenance, line, and age in days. */
export interface StampScanEntry {
  /** Absolute path of the body file. */
  path: string;
  /** Path relative to the conception root. */
  relPath: string;
  /** 1-based line the stamp was found on. */
  line: number;
  /** ISO `YYYY-MM-DD` date on the stamp. */
  verifiedAt: string;
  /** Trailing provenance text after the date. */
  where: string;
  /** Whole-day age of the stamp relative to the scan time. */
  ageDays: number;
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
 * @param maxAgeDays freshness window (default 30)
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
    const stamp = parseVerifiedStamp(raw);
    const relPath = relative(conceptionPath, path);
    if (!stamp) {
      unstamped.push(relPath);
      continue;
    }
    const ageDays = stampAgeDays(stamp.verifiedAt, today);
    const entry: StampScanEntry = {
      path,
      relPath,
      line: stamp.line,
      verifiedAt: stamp.verifiedAt,
      where: stamp.where,
      ageDays,
    };
    if (ageDays > maxAgeDays) stale.push(entry);
    else fresh.push(entry);
  }
  return { stale, fresh, unstamped, maxAgeDays };
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
    message: `Verification stamp from ${entry.verifiedAt} (${entry.ageDays}d ago) is older than ${result.maxAgeDays}-day threshold`,
    fix: {
      action: 'flag_for_user_review',
      autoFix: false,
      verifiedAt: entry.verifiedAt,
      ageDays: entry.ageDays,
      where: entry.where,
    },
  }));
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
