import type { AutoSyncStatus } from '../../shared/types';
import type { SyncReport } from './run';

type Episode = NonNullable<AutoSyncStatus['blockedEpisode']>;

/** Session-scoped suppression independent of scheduling phases; notification failures are nonfatal. */
export class BlockedEpisode {
  private current: Episode | null = null;

  get value(): Episode | null {
    return this.current;
  }

  observe(report: SyncReport, now: number, notify: (episode: Episode) => void): void {
    if (report.locked || report.dryRun) return;
    if (report.diverged || report.integrateError) {
      const first = this.current === null;
      this.current = { since: this.current?.since ?? now, waitingCommits: report.ahead ?? null };
      if (first) {
        try {
          notify(this.current);
        } catch {
          /* Desktop delivery cannot fail a sweep. */
        }
      }
    } else if (report.behind === 0 && report.ahead !== null && !report.pushError) {
      // A skipped integration (off/no-push/no-upstream) is not reconciliation.
      this.current = null;
    }
  }
}
