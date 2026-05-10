import { onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { LayoutState, WorkingSurface } from '@shared/types';
import type { HelpDoc } from './help-modal';

export interface MenuRouterDeps {
  conceptionPath: Accessor<string | null>;
  layout: Accessor<LayoutState>;
  setConceptionPath: (next: string | null) => void;
  bumpRefreshKey: () => void;
  setSearchModalOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setNewProjectOpen: (open: boolean) => void;
  setQuitConfirmOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
  setHelpDoc: (doc: HelpDoc) => void;
  toggleProjects: () => void;
  toggleTerminal: () => void;
  selectWorking: (next: WorkingSurface) => void;
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
    if (command === 'toggle-projects') {
      deps.toggleProjects();
      return;
    }
    if (command === 'show-code') {
      deps.selectWorking(deps.layout().working === 'code' ? null : 'code');
      return;
    }
    if (command === 'show-knowledge') {
      deps.selectWorking(deps.layout().working === 'knowledge' ? null : 'knowledge');
      return;
    }
    if (command === 'show-resources') {
      deps.selectWorking(deps.layout().working === 'resources' ? null : 'resources');
      return;
    }
    if (command === 'show-skills') {
      deps.selectWorking(deps.layout().working === 'skills' ? null : 'skills');
      return;
    }
    if (command === 'hide-working') {
      deps.selectWorking(null);
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
        deps.setConceptionPath(newPath);
        deps.bumpRefreshKey();
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
}
