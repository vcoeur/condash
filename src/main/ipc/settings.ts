import { ipcMain } from 'electron';
import { toPosix } from '../../shared/path';
import { DEFAULT_LAYOUT, readSettings, settingsPath, updateSettings } from '../settings';
import type { LayoutState, Theme } from '../../shared/types';

const THEMES: ReadonlySet<Theme> = new Set(['light', 'dark', 'system']);

/**
 * Wire every theme / layout / welcome / settings-path IPC handler.
 *
 * `onLayoutChange` is invoked on every successful setLayout — main entry
 * uses it to rebuild the application menu so the View submenu's check
 * marks line up with the new state.
 */
export function registerSettingsIpc(opts: { onLayoutChange: (layout: LayoutState) => void }): void {
  ipcMain.handle('getTheme', async () => {
    const { theme } = await readSettings();
    return theme;
  });

  ipcMain.handle('getSettingsPath', () => toPosix(settingsPath()));

  ipcMain.handle('setTheme', async (_, theme: Theme) => {
    if (!THEMES.has(theme)) throw new Error(`Unknown theme: ${theme}`);
    await updateSettings((cur) => ({ ...cur, theme }));
  });

  ipcMain.handle('getLayout', async () => {
    const { layout } = await readSettings();
    return layout ?? DEFAULT_LAYOUT;
  });

  ipcMain.handle('setLayout', async (_, layout: LayoutState) => {
    await updateSettings((cur) => ({ ...cur, layout }));
    opts.onLayoutChange(layout);
  });

  ipcMain.handle('getWelcomeDismissed', async () => {
    const { welcome } = await readSettings();
    return welcome?.dismissed === true;
  });

  ipcMain.handle('setWelcomeDismissed', async (_, value: boolean) => {
    await updateSettings((cur) => ({
      ...cur,
      welcome: { ...(cur.welcome ?? {}), dismissed: value },
    }));
  });
}
