import { ipcMain } from 'electron';
import { getDashboardConfigView, getDashboardState } from '../dashboard/engine';
import { requireMainWindowSender } from './utils';

/** Wire the dashboard read IPC handlers. The push channels (state + per-tab
 *  summaries) are sent from the engine; these two are pull accessors the
 *  Dashboard pane uses on mount. Called once from main entry. */
export function registerDashboardIpc(): void {
  ipcMain.handle('dashboardGetState', (event) => {
    requireMainWindowSender(event);
    return getDashboardState();
  });

  ipcMain.handle('dashboardGetConfigView', (event) => {
    requireMainWindowSender(event);
    return getDashboardConfigView();
  });
}
