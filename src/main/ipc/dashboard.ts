import { ipcMain } from 'electron';
import type { DashboardSettings } from '../../shared/types';
import { getDashboardConfigView, getDashboardState } from '../dashboard/engine';
import { resolveDashboardConfig } from '../dashboard/config';
import { testDashboardConnection } from '../dashboard/summarizer';
import { requireMainWindowSender, requireOptionalRecord } from './utils';

/** Wire the dashboard read IPC handlers. The push channels (state + per-tab
 *  summaries) are sent from the engine; these are pull accessors the Dashboard
 *  pane + Settings use. Called once from main entry. */
export function registerDashboardIpc(): void {
  ipcMain.handle('dashboardGetState', (event) => {
    requireMainWindowSender(event);
    return getDashboardState();
  });

  ipcMain.handle('dashboardGetConfigView', (event) => {
    requireMainWindowSender(event);
    return getDashboardConfigView();
  });

  // Test the settings the user is editing (draft values, key included). The
  // summarizer's test helper never throws — it resolves { ok, error? }.
  ipcMain.handle('dashboardTestConnection', (event, settings: unknown) => {
    requireMainWindowSender(event);
    const draft = requireOptionalRecord('dashboardTestConnection', settings) as
      | DashboardSettings
      | undefined;
    return testDashboardConnection(resolveDashboardConfig(draft));
  });
}
