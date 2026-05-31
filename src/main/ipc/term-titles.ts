import { ipcMain } from 'electron';
import { readTermTitles } from '../term-titles';
import { readSettings } from '../settings';

/**
 * IPC for capability 3's apply path. The live channel is the push-only
 * `termAutoTitles` event (broadcast by `term-titles-watcher.ts`); this verb is
 * the pull complement so a freshly-mounted renderer (or one reloaded after a
 * crash) can paint the current titles without waiting for the next file write.
 */
export function registerTermTitlesIpc(): void {
  ipcMain.handle('termAutoTitlesList', async () => {
    const { lastConceptionPath } = await readSettings();
    if (!lastConceptionPath) return [];
    return readTermTitles(lastConceptionPath);
  });
}
