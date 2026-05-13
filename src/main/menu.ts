import { BrowserWindow, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { DEFAULT_LAYOUT, readSettings } from './settings';
import type { LayoutState } from '../shared/types';

type Recents = { paths: string[]; current: string | null };

let mainWindowRef: BrowserWindow | null = null;
let lastLayout: LayoutState = DEFAULT_LAYOUT;
let lastRecents: Recents = { paths: [], current: null };

/** Inject the live window reference. Menu callbacks fire IPC at the window. */
export function setMenuWindow(win: BrowserWindow | null): void {
  mainWindowRef = win;
}

/**
 * Format a recents path for the File → Open Recent submenu. The basename
 * (e.g. `conception`) carries the visual weight; the parent directory is
 * shown after a dimmed em-dash so two trees with the same basename don't
 * look identical.
 */
function prettyRecentLabel(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return path;
  const tail = segments[segments.length - 1];
  const head = segments.slice(0, -1).join('/');
  if (!head) return tail;
  // The Electron menu strips raw `/` runs in some renders; collapse the
  // parent path to a tilde-anchored form when it lives under HOME.
  return `${tail} — ${head}`;
}

/**
 * Build the application menu. The View submenu mirrors the unified
 * layout's pane-visibility state — Show/Hide Projects + Show/Hide
 * Terminal as toggles, plus a three-state group (Code | Knowledge |
 * neither) for the right-slot working surface. Pass the current layout
 * so check marks line up with what's actually shown; rebuild the menu
 * after any layout change so the marks refresh. No Quit accelerator on
 * purpose: Ctrl+Q is too easy to hit by accident, and File → Quit
 * routes through a renderer-side confirmation modal anyway.
 */
export function buildMenu(
  layout: LayoutState = DEFAULT_LAYOUT,
  recents: Recents = { paths: [], current: null },
): void {
  lastLayout = layout;
  lastRecents = recents;
  const send = (command: string): void => {
    mainWindowRef?.webContents.send('menu-command', command);
  };

  const openRecentSubmenu: MenuItemConstructorOptions[] = recents.paths.length
    ? [
        ...recents.paths.map((path) => ({
          label: prettyRecentLabel(path),
          type: 'checkbox' as const,
          checked: path === recents.current,
          click: () => {
            mainWindowRef?.webContents.send('menu-open-recent', path);
          },
        })),
        { type: 'separator' as const },
        {
          label: 'Clear menu',
          click: () => {
            mainWindowRef?.webContents.send('menu-clear-recents');
          },
        },
      ]
    : [{ label: '(no recent conceptions)', enabled: false }];

  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Open…',
      accelerator: 'CommandOrControl+O',
      click: () => send('open-folder'),
    },
    {
      label: 'Open Recent',
      submenu: openRecentSubmenu,
    },
    {
      label: 'Open conception directory',
      click: () => send('open-conception'),
    },
    {
      label: 'New project…',
      accelerator: 'CommandOrControl+N',
      click: () => send('new-project'),
    },
    { type: 'separator' },
    {
      label: 'Settings',
      accelerator: 'CommandOrControl+,',
      click: () => send('open-settings'),
    },
    {
      // Two accelerators for the same action — Electron menus only honour
      // one accelerator per item, so the Ctrl+K binding is wired in the
      // renderer's handleGlobalKeyDown (the cheat-sheet documents both).
      label: 'Search…',
      accelerator: 'CommandOrControl+Shift+F',
      click: () => send('search'),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      // No accelerator on purpose — see the comment above buildMenu().
      click: () => send('request-quit'),
    },
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Show Projects',
      type: 'checkbox',
      checked: layout.projects,
      click: () => send('toggle-projects'),
    },
    {
      label: 'Show Code',
      type: 'checkbox',
      checked: layout.working === 'code',
      accelerator: 'CommandOrControl+Shift+C',
      click: () => send('show-code'),
    },
    {
      label: 'Show Knowledge',
      type: 'checkbox',
      checked: layout.working === 'knowledge',
      accelerator: 'CommandOrControl+Shift+K',
      click: () => send('show-knowledge'),
    },
    {
      label: 'Show Resources',
      type: 'checkbox',
      checked: layout.working === 'resources',
      accelerator: 'CommandOrControl+R',
      click: () => send('show-resources'),
    },
    {
      label: 'Show Skills',
      type: 'checkbox',
      checked: layout.working === 'skills',
      accelerator: 'CommandOrControl+L',
      click: () => send('show-skills'),
    },
    {
      label: 'Show Logs',
      type: 'checkbox',
      checked: layout.working === 'logs',
      accelerator: 'CommandOrControl+Shift+L',
      click: () => send('show-logs'),
    },
    {
      label: 'Hide working surface',
      enabled: layout.working !== null,
      click: () => send('hide-working'),
    },
    {
      label: 'Show Terminal',
      type: 'checkbox',
      checked: layout.terminal,
      accelerator: 'CommandOrControl+`',
      click: () => send('toggle-terminal'),
    },
    { type: 'separator' },
    {
      label: 'Refresh',
      accelerator: 'F5',
      click: () => send('refresh'),
    },
    { type: 'separator' },
    {
      role: 'reload',
      label: 'Reload window',
      // Reload normally lives at Ctrl+R, but we hand that accelerator to the
      // Resources panel (more useful in day-to-day work). Reload moves to
      // Ctrl+Shift+R, which still aligns with browser muscle memory for
      // a hard reload.
      accelerator: 'CommandOrControl+Shift+R',
    },
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  const helpSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'About Condash',
      click: () => send('about'),
    },
    { type: 'separator' },
    { label: 'Welcome', click: () => send('help-welcome') },
    { label: 'Quick start', click: () => send('help-quick-start') },
    { label: 'Keyboard shortcuts', click: () => send('help-shortcuts') },
    { type: 'separator' },
    { label: 'Configuration', click: () => send('help-configuration') },
    { label: 'CLI overview', click: () => send('help-cli') },
    { label: 'Why Markdown-first', click: () => send('help-why-markdown') },
    { type: 'separator' },
    {
      label: 'Open documentation site',
      click: () => {
        void shell
          .openExternal('https://condash.vcoeur.com')
          .catch((err) => console.error('[menu] openExternal failed', err));
      },
    },
    {
      label: 'Open issue tracker',
      click: () => {
        void shell
          .openExternal('https://github.com/vcoeur/condash/issues')
          .catch((err) => console.error('[menu] openExternal failed', err));
      },
    },
  ];

  const template: MenuItemConstructorOptions[] = [
    { label: 'File', submenu: fileSubmenu },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: viewSubmenu },
    { label: 'Help', role: 'help', submenu: helpSubmenu },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Rebuild the application menu against the latest layout. Used as the
 * `onLayoutChange` hook by registerSettingsIpc — the View submenu's check
 * marks need to refresh after every layout mutation.
 */
export function rebuildMenu(layout: LayoutState): void {
  buildMenu(layout, lastRecents);
}

/**
 * Re-read settings.json for the recents list and rebuild against the
 * cached layout. Used after the conception path or recents list changes.
 */
export async function rebuildMenuFromSettings(): Promise<void> {
  const settings = await readSettings();
  lastRecents = {
    paths: settings.recentConceptionPaths ?? [],
    current: settings.lastConceptionPath,
  };
  buildMenu(lastLayout, lastRecents);
}
