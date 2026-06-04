import { createEffect, createMemo, createSignal, Show } from 'solid-js';
import { slugify } from '@shared/slug';
import { Modal } from './modal';
import { ActionBar, Button } from './actions';
import './prompt-modal.css';

export interface PromptModalState {
  title: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  /** When true, render a `slugified-preview` line under the input so the
   *  user can see the on-disk shape they're about to commit to. Mirrors
   *  the NewProjectModal's title→slug preview. Off by default. */
  slugPreview?: boolean;
  resolve: (value: string | null) => void;
}

/**
 * Lightweight in-app text-input prompt. Replaces window.prompt(), which
 * Electron renderers no-op silently (returns null with no UI shown).
 */
export function PromptModal(props: { state: PromptModalState | null; onClose: () => void }) {
  const [value, setValue] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

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

  // Reuse the NewProjectModal's title→slug normalisation so the user sees
  // exactly the on-disk tail the create command would produce. `slugify`
  // returns '' on empty/no-alnum input — the preview hides itself in that
  // case so the user isn't told their slug is "" before they've typed.
  const slugPreviewValue = createMemo(() => {
    if (!props.state?.slugPreview) return '';
    return slugify(value());
  });

  return (
    <Show when={props.state}>
      {(state) => (
        <Modal class="prompt-modal" title={state().title} onClose={cancel}>
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
                  e.stopPropagation();
                  confirm();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancel();
                }
              }}
            />
            <Show when={state().slugPreview && slugPreviewValue().length > 0}>
              <p class="prompt-slug-preview">
                Slug: <code>{slugPreviewValue()}</code>
              </p>
            </Show>
            <ActionBar>
              <Button variant="default" onClick={cancel}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirm} disabled={value().trim().length === 0}>
                {state().confirmLabel ?? 'OK'}
              </Button>
            </ActionBar>
          </div>
        </Modal>
      )}
    </Show>
  );
}
