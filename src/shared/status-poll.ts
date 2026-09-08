/** How often the status bar re-reads the sync/skills snapshots
 *  (`status-bar-indicators.tsx`). Commit cadence is minutes; the
 *  `auto-sync-status` push refreshes the sync side the instant a sweep lands,
 *  so 20 s is plenty.
 *
 *  Lives in shared/ (plain .ts) so the guard test in
 *  `main/git-status-cache.test.ts` can pin it below `STATUS_TTL_MS` without
 *  importing a renderer `.tsx` (tsconfig.main carries no `jsx` flag) — a TTL
 *  shorter than this cadence makes every poll a guaranteed cache miss. */
export const POLL_MS = 20_000;
