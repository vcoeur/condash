import { Show } from 'solid-js';
import type { HelpDoc } from './help-modal';

export type Tab = 'projects' | 'knowledge' | 'code';

/** Top-of-window toolbar: tab buttons (Projects / Code / Knowledge),
 *  pane toggle, settings, help-menu dropdown, refresh, and the conception
 *  folder picker. Pure presentation — every button is a callback. */
export function Toolbar(props: {
  tab: Tab;
  conceptionPath: string | null;
  terminalOpen: boolean;
  helpMenuOpen: boolean;
  onTabChange: (tab: Tab) => void;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
  onToggleHelpMenu: (e: MouseEvent) => void;
  onOpenHelp: (doc: HelpDoc) => void;
  onRefresh: () => void;
  onPickFolder: () => void;
}) {
  return (
    <header class="toolbar">
      <nav class="tabs main-tabs">
        <button
          class="tab"
          classList={{ active: props.tab === 'projects' }}
          onClick={() => props.onTabChange('projects')}
        >
          Projects
        </button>
        <button
          class="tab"
          classList={{ active: props.tab === 'code' }}
          onClick={() => props.onTabChange('code')}
          disabled={!props.conceptionPath}
        >
          Code
        </button>
        <button
          class="tab"
          classList={{ active: props.tab === 'knowledge' }}
          onClick={() => props.onTabChange('knowledge')}
          disabled={!props.conceptionPath}
        >
          Knowledge
        </button>
      </nav>
      <span class="spacer" />
      <button
        onClick={props.onToggleTerminal}
        classList={{ active: props.terminalOpen }}
        title="Toggle terminal pane (Ctrl+`)"
      >
        ▤
      </button>
      <button onClick={props.onOpenSettings} disabled={!props.conceptionPath} title="Settings">
        ⚙
      </button>
      <span class="help-menu-wrap">
        <button onClick={props.onToggleHelpMenu} title="Help / docs">
          ?
        </button>
        <Show when={props.helpMenuOpen}>
          <div class="help-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <button class="help-menu-item" onClick={() => props.onOpenHelp('architecture')}>
              Architecture
            </button>
            <button class="help-menu-item" onClick={() => props.onOpenHelp('configuration')}>
              Configuration reference
            </button>
            <button class="help-menu-item" onClick={() => props.onOpenHelp('non-goals')}>
              Non-goals
            </button>
            <button class="help-menu-item" onClick={() => props.onOpenHelp('index')}>
              Documentation index
            </button>
          </div>
        </Show>
      </span>
      <button onClick={props.onRefresh} disabled={!props.conceptionPath}>
        Refresh
      </button>
      <button onClick={props.onPickFolder}>
        {props.conceptionPath ? 'Change…' : 'Choose folder…'}
      </button>
    </header>
  );
}

/** Confirm modal shown before quitting the app — terminates running pty
 *  sessions, so we want an explicit confirmation. */
export function QuitConfirmModal(props: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div class="modal-backdrop" onClick={props.onCancel}>
      <div
        class="modal quit-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Quit Condash"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">Quit Condash?</span>
        </header>
        <div class="quit-confirm-body">
          <p>Any running terminal sessions will be terminated.</p>
          <div class="quit-confirm-actions">
            <button class="modal-button" onClick={props.onCancel}>
              Cancel
            </button>
            <button class="modal-button warn" onClick={props.onConfirm} autofocus>
              Quit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
