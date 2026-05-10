import { type JSX, onCleanup, onMount, Show } from 'solid-js';
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
 * Reusable confirmation dialog — replaces ad-hoc copies of QuitConfirmModal
 * and the native `window.confirm()` calls scattered through the renderer.
 * The Init "lay down the template?" prompt and the per-card force-stop /
 * unsaved-edits prompts all funnel through this one shape.
 */
export function ConfirmModal(props: ConfirmModalProps) {
  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
    } else if (event.key === 'Enter') {
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
    <div class="modal-backdrop" onClick={props.onCancel}>
      <div
        class="modal confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">{props.title}</span>
          <span class="modal-head-spacer" />
          <button
            class="modal-button"
            onClick={props.onCancel}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </header>
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
      </div>
    </div>
  );
}
