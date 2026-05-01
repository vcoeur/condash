import { Show } from 'solid-js';
import type { LayoutState } from '@shared/types';
import './toolbar.css';

/** Top-of-window toolbar — only the search input now.
 *
 * Pane visibility is toggled from the edge handles around the workspace
 * (see `.edge-strip-*` in main.tsx). The toolbar's job is the per-pane
 * search box; placeholder text adapts to whichever searchable panes are
 * visible (Projects and / or Knowledge). */
export function Toolbar(props: {
  layout: LayoutState;
  conceptionPath: string | null;
  searchValue: string;
  onSearchInput: (value: string) => void;
}) {
  const showSearch = (): boolean =>
    !!props.conceptionPath && (props.layout.projects || props.layout.working === 'knowledge');

  const placeholder = (): string => {
    const tokens: string[] = [];
    if (props.layout.projects) tokens.push('projects');
    if (props.layout.working === 'knowledge') tokens.push('knowledge');
    if (tokens.length === 0) return '';
    return `Search ${tokens.join(' + ')} — multi-word AND, "phrases" stay together`;
  };

  return (
    <header class="toolbar">
      <Show when={showSearch()} fallback={<div class="toolbar-spacer" />}>
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
