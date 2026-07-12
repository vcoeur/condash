import { ipcMain } from 'electron';
import { getAutoSyncStatus, syncNow } from '../sync/auto-engine';
import { getSyncStatusSnapshot } from '../sync/status-snapshot';
import type { SyncStatusSnapshot } from '../../shared/types';
import { requireMainWindowSender, withConception } from './utils';

const EMPTY_SNAPSHOT: SyncStatusSnapshot = {
  pendingCount: 0,
  ahead: 0,
  hasUpstream: false,
  recentCommits: [],
};

/** Wire the auto-sync read + action IPC handlers. The status push channel is
 *  sent from the engine; these back the Settings section. Called once from main
 *  entry. */
export function registerAutoSyncIpc(): void {
  ipcMain.handle('autoSyncGetStatus', (event) => {
    requireMainWindowSender(event);
    return getAutoSyncStatus();
  });

  // The "Commit & push now" button — one sweep, regardless of the cadence. The
  // engine no-ops (returns current status) when unarmed or already mid-sweep.
  ipcMain.handle('autoSyncNow', (event) => {
    requireMainWindowSender(event);
    return syncNow();
  });

  // Read-only sync snapshot (pending-file count + unpushed count + recent
  // commits) for the status-bar auto-sync indicator. Disjoint from the engine
  // — never takes the sync lock.
  ipcMain.handle('syncStatusSnapshot', (event) => {
    requireMainWindowSender(event);
    return withConception(
      (conceptionPath) => getSyncStatusSnapshot(conceptionPath),
      EMPTY_SNAPSHOT,
    );
  });
}
