import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';

export interface PromptModalState {
  title: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  resolve: (value: string | null) => void;
}

/**
 * Lightweight in-app text-input prompt. Replaces window.prompt(), which
 * Electron renderers no-op silently (returns null with no UI shown).
 */
export function PromptModal(props: { state: PromptModalState | null; onClose: () => void }) {
  const [value, setValue] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  const handleKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
    event.preventDefault();
    cancel();
  };

  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));

  // Reset value + focus the input each time a new prompt opens.
  createEffect(() => {
    const s = props.state;
    if (!s) return;
    setValue(s.initialValue ?? '');
    queueMicrotask(() => inputRef?.focus());
  });

  const confirm = (): void => {
    const s = props.state;
    if (!s) return;
    s.resolve(value());
    props.onClose();
  };

  const cancel = (): void => {
    const s = props.state;
    if (s) s.resolve(null);
    props.onClose();
  };

  return (
    <Show when={props.state}>
      {(state) => (
        <div class="modal-backdrop" onClick={cancel}>
          <div
            class="modal prompt-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <header class="modal-head">
              <span class="modal-title">{state().title}</span>
            </header>
            <div class="prompt-body">
              <Show when={state().message}>
                <p class="prompt-message">{state().message}</p>
              </Show>
              <input
                ref={(el) => (inputRef = el)}
                class="prompt-input"
                type="text"
                placeholder={state().placeholder ?? ''}
                value={value()}
                onInput={(e) => setValue(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirm();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancel();
                  }
                }}
              />
              <div class="prompt-actions">
                <button class="modal-button" onClick={cancel}>
                  Cancel
                </button>
                <button
                  class="modal-button"
                  onClick={confirm}
                  disabled={value().trim().length === 0}
                >
                  {state().confirmLabel ?? 'OK'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
