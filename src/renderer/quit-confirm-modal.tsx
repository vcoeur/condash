import { Show } from 'solid-js';
import { useModalEscHandler } from './modal-helpers';

/** Confirm modal shown before quitting the app — terminates running pty
 *  sessions, so we want an explicit confirmation. When `noteDirty` is set,
 *  surfaces an additional "unsaved note edits will be lost" warning so the
 *  user sees both stakes inside one modal instead of two stacked confirms. */
export function QuitConfirmModal(props: {
  onCancel: () => void;
  onConfirm: () => void;
  noteDirty?: boolean;
}) {
  useModalEscHandler(props.onCancel);

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
          <span class="modal-head-spacer" />
          <button
            class="modal-button"
            onClick={props.onCancel}
            title="Cancel (Esc)"
            aria-label="Cancel"
          >
            ×
          </button>
        </header>
        <div class="quit-confirm-body">
          <p>Any running terminal sessions will be terminated.</p>
          <Show when={props.noteDirty}>
            <p class="quit-confirm-warn">Unsaved note edits will also be lost.</p>
          </Show>
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
