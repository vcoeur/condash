import { ipcMain } from 'electron';
import type { BootstrapData, OpenWithSlots } from '../../shared/types';
import { toPosix } from '../../shared/path';
import { readSettings } from '../settings';
import { listOpenWith } from '../launchers';
import { getTerminalPrefs } from '../terminals';
import { requireMainWindowSender } from './utils';
import {
  resolveBranchFilterStickyAll,
  resolveCardMinWidth,
  resolveLayout,
  resolveProjectCardTitleFont,
  resolveSelectedBranches,
  resolveSkillsActiveScope,
  resolveTheme,
  resolveTreeExpansion,
  resolveWelcomeDismissed,
} from './settings';

/**
 * Wire the single `bootstrap` IPC (review finding S6). One handler assembles the
 * active conception path plus every mount-time settings value the renderer would
 * otherwise fetch through the serial `getConceptionPath` gate followed by ~9
 * parallel settings getters — collapsing all of it into one round-trip backed by
 * one `readSettings()` (+ one memoized `getEffectiveConceptionConfig`). Each
 * field is produced by the same resolver the individual `get*` handler calls
 * (ipc/settings.ts), so the bootstrap bundle can never diverge from the getters.
 */
export function registerBootstrapIpc(): void {
  ipcMain.handle('bootstrap', async (event): Promise<BootstrapData> => {
    requireMainWindowSender(event);
    const settings = await readSettings();
    // Raw path for the config-bound reads below (listOpenWith takes the raw form,
    // matching its own IPC); the surfaced `conceptionPath` field is posix-normalised
    // to match `getConceptionPath`, upholding the "every path crossing IPC is posix"
    // invariant (a Windows/env-override path may carry backslashes here).
    const conceptionPath = settings.lastConceptionPath;
    // The config-bound reads (open-with slots + terminal prefs) run in parallel
    // with the effective-config-backed resolvers (theme, card min-widths). Every
    // readSettings / getEffectiveConceptionConfig underneath is mtime-memoized,
    // so the whole bundle resolves against a single read of each file.
    const [theme, projectCardTitleFont, cardMinWidth, openWith, terminalPrefs] = await Promise.all([
      resolveTheme(settings),
      resolveProjectCardTitleFont(settings),
      resolveCardMinWidth(settings),
      conceptionPath ? listOpenWith(conceptionPath) : Promise.resolve<OpenWithSlots>({}),
      getTerminalPrefs(),
    ]);
    return {
      conceptionPath: conceptionPath ? toPosix(conceptionPath) : null,
      theme,
      projectCardTitleFont,
      layout: resolveLayout(settings),
      welcomeDismissed: resolveWelcomeDismissed(settings),
      cardMinWidth,
      treeExpansion: resolveTreeExpansion(settings),
      selectedBranches: resolveSelectedBranches(settings),
      branchFilterStickyAll: resolveBranchFilterStickyAll(settings),
      skillsActiveScope: resolveSkillsActiveScope(settings),
      openWith,
      terminalPrefs,
    };
  });
}
