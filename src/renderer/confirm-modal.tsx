import { type JSX, onCleanup, onMount, Show } from 'solid-js';
import { Modal } from './modal';
import './confirm-modal.css';

export interface ConfirmModalProps {
  /** Heading shown in the modal-head bar. */
  title: string;
  /** Optional secondary copy under the title; arbitrary JSX so callers can
   *  render lists or formatted spans. */
  body?: string | (() => JSX.Element);
  /** Default 'Confirm'. */
  confirmLabel?: string;
  /** Default 'Cancel'. */
  cancelLabel?: string;
  /** Style the confirm button as a destructive action (red accent). */
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Reusable confirmation dialog — the single confirm surface for the renderer,
 * replacing the native `window.confirm()` calls. The quit prompt, the Init
 * "lay down the template?" prompt, and the per-card force-stop / unsaved-edits
 * prompts all funnel through this one shape.
 */
export function ConfirmModal(props: ConfirmModalProps) {
  // Esc → cancel and backdrop dismissal are owned by the shared <Modal>
  // shell. Confirm adds Enter-to-confirm on top, so it keeps a keydown
  // listener for that one key.
  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'BUTTON') return;
      event.preventDefault();
      event.stopPropagation();
      props.onConfirm();
    }
  };

  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));

  return (
    <Modal
      class="confirm-modal"
      role="alertdialog"
      ariaLabel={props.title}
      title={props.title}
      onClose={props.onCancel}
    >
      <div class="confirm-body">
        <Show when={props.body !== undefined}>
          {typeof props.body === 'string' ? (
            <p class="confirm-message">{props.body}</p>
          ) : (
            (props.body as () => JSX.Element)()
          )}
        </Show>
        <div class="confirm-actions">
          <button class="modal-button" onClick={props.onCancel}>
            {props.cancelLabel ?? 'Cancel'}
          </button>
          <button
            class="modal-button"
            classList={{ warn: props.destructive === true }}
            onClick={props.onConfirm}
            autofocus
          >
            {props.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
