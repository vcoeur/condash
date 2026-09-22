import { onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { LayoutState } from '@shared/types';
import type { HelpDoc } from './help-modal';

export interface MenuRouterDeps {
  conceptionPath: Accessor<string | null>;
  layout: Accessor<LayoutState>;
  setConceptionPath: (next: string | null) => void;
  setSearchModalOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setNewProjectOpen: (open: boolean) => void;
  setQuitConfirmOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
  setHelpDoc: (doc: HelpDoc) => void;
  toggleTerminal: () => void;
  /** Select the right-pane surface directly (persisted; never a toggle). */
  selectWorking: (next: LayoutState['working']) => void;
  /** Toggle the Dashboard body in the bottom band (next to Terminal). */
  toggleDashboardBand: () => void;
  showDiagnosticsBand: () => void;
  handleRefresh: () => void;
  handlePick: () => Promise<void>;
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

/**
 * Application menu → renderer plumbing. Wires three IPC subscriptions
 * (`onMenuCommand`, `onMenuOpenRecent`, `onMenuClearRecents`) and
 * registers their cleanups via Solid's `onCleanup` so they tear down
 * when the host scope disposes.
 */
export function createMenuRouter(deps: MenuRouterDeps): void {
  const offMenu = window.condash.onMenuCommand((command) => {
    if (command === 'search') {
      deps.setSearchModalOpen(true);
      return;
    }
    if (command === 'open-folder') {
      void deps.handlePick();
      return;
    }
    if (command === 'open-conception') {
      void window.condash.openConceptionDirectory().catch((err) => {
        deps.flashToast(`Open failed: ${(err as Error).message}`, 'error');
      });
      return;
    }
    if (command === 'open-settings') {
      if (deps.conceptionPath()) deps.setSettingsOpen(true);
      return;
    }
    if (command === 'request-quit') {
      deps.setQuitConfirmOpen(true);
      return;
    }
    if (command === 'new-project') {
      if (deps.conceptionPath()) deps.setNewProjectOpen(true);
      return;
    }
    if (command === 'toggle-terminal') {
      deps.toggleTerminal();
      return;
    }
    if (
      command === 'show-code' ||
      command === 'show-knowledge' ||
      command === 'show-resources' ||
      command === 'show-skills' ||
      command === 'show-automations' ||
      command === 'show-logs'
    ) {
      // Strip the `show-` prefix: the rest is the WorkingSurface name. Every
      // command is a direct selection — the pane the menu names is the pane
      // that shows, never a toggle (the rail is the complete navigation).
      deps.selectWorking(command.slice('show-'.length) as LayoutState['working']);
      return;
    }
    if (command === 'show-terminal-diagnostics') {
      deps.showDiagnosticsBand();
      return;
    }
    if (command === 'show-dashboard') {
      deps.toggleDashboardBand();
      return;
    }
    if (command === 'refresh') {
      deps.handleRefresh();
      return;
    }
    if (command === 'about') {
      deps.setAboutOpen(true);
      return;
    }
    if (command.startsWith('help-')) {
      // Strip the `help-` prefix to get the HelpDoc name.
      const doc = command.slice('help-'.length) as HelpDoc;
      deps.setHelpDoc(doc);
      return;
    }
  });
  onCleanup(offMenu);

  const offMenuOpenRecent = window.condash.onMenuOpenRecent((path) => {
    void window.condash
      .openConception(path)
      .then((newPath) => {
        // Setting the conception path cascades through every store's
        // `createEffect(conceptionPath)` (projects, knowledge, resources,
        // skills, repos, config), so no explicit refresh bump is needed.
        deps.setConceptionPath(newPath);
      })
      .catch((err) => {
        deps.flashToast(`Open failed: ${(err as Error).message}`, 'error');
      });
  });
  onCleanup(offMenuOpenRecent);

  const offMenuClearRecents = window.condash.onMenuClearRecents(() => {
    void window.condash.clearRecentConceptionPaths().catch((err) => {
      deps.flashToast(`Clear recents failed: ${(err as Error).message}`, 'error');
    });
  });
  onCleanup(offMenuClearRecents);

  // Surface file-watcher failures (e.g. inotify exhaustion) the main process
  // pushes — otherwise the tree/dirty views silently stop auto-updating (W3).
  const offWatcherStatus = window.condash.onWatcherStatus((msg) => {
    deps.flashToast(msg.message, msg.kind);
  });
  onCleanup(offWatcherStatus);
}
