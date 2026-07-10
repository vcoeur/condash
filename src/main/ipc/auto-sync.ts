import { ipcMain } from 'electron';
import { getAutoSyncStatus, syncNow } from '../sync/auto-engine';
import { requireMainWindowSender } from './utils';

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
}
