import { useModalEscHandler } from './modal-helpers';

/** Confirm modal shown before quitting the app — terminates running pty
 *  sessions, so we want an explicit confirmation. */
export function QuitConfirmModal(props: { onCancel: () => void; onConfirm: () => void }) {
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
