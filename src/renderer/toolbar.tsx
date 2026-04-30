import { Show } from 'solid-js';
import './toolbar.css';

export type Tab = 'projects' | 'knowledge' | 'code';

/** Top-of-window toolbar — tab buttons + the search input for the active
 * tab (Projects / Knowledge only).
 *
 * Other actions (Show Terminal, Refresh, Settings, Open conception
 * folder, About / Help docs) live in the application menu now. The
 * toolbar's job is workspace navigation + the per-tab search box. */
export function Toolbar(props: {
  tab: Tab;
  conceptionPath: string | null;
  searchValue: string;
  onSearchInput: (value: string) => void;
  onTabChange: (tab: Tab) => void;
}) {
  const placeholder = (): string => {
    if (props.tab === 'projects')
      return 'Search projects — multi-word AND, "phrases" stay together';
    if (props.tab === 'knowledge')
      return 'Search knowledge — multi-word AND, "phrases" stay together';
    return '';
  };
  const showSearch = (): boolean =>
    !!props.conceptionPath && (props.tab === 'projects' || props.tab === 'knowledge');

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
      <Show when={showSearch()}>
        <input
          class="toolbar-search"
          type="search"
          placeholder={placeholder()}
          value={props.searchValue}
          onInput={(e) => props.onSearchInput(e.currentTarget.value)}
        />
      </Show>
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
