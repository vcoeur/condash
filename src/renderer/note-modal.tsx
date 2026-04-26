import { createEffect, createResource, onCleanup, onMount, Show } from 'solid-js';
import { renderMarkdown, runMermaidIn } from './markdown';
import 'highlight.js/styles/github.css';

export type ModalState = {
  path: string;
  title?: string;
} | null;

export function NoteModal(props: {
  state: ModalState;
  onClose: () => void;
  onOpenInEditor: (path: string) => void;
}) {
  const [content] = createResource(
    () => props.state?.path,
    async (path) => (path ? await window.condash.readNote(path) : null),
  );

  const html = (): string => {
    const text = content();
    if (text == null) return '';
    return renderMarkdown(text);
  };

  let bodyRef: HTMLDivElement | undefined;

  createEffect(() => {
    // Re-run when html() changes — Solid tracks the dependency.
    void html();
    if (bodyRef) {
      void runMermaidIn(bodyRef);
    }
  });

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
  });

  onCleanup(() => {
    document.removeEventListener('keydown', handleKeydown, true);
  });

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal note-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">{props.state?.title ?? props.state?.path ?? ''}</span>
          <span class="modal-path">{props.state?.path ?? ''}</span>
          <button
            class="modal-button"
            onClick={() => props.state && props.onOpenInEditor(props.state.path)}
            title="Open in $EDITOR"
          >
            ✎
          </button>
          <button class="modal-button" onClick={props.onClose} title="Close (Esc)">
            ×
          </button>
        </header>
        <div class="modal-body" ref={(el) => (bodyRef = el)}>
          <Show when={content.loading}>
            <div class="empty">Loading…</div>
          </Show>
          <Show when={content.error}>
            <div class="empty warn">Failed to read: {(content.error as Error).message}</div>
          </Show>
          <Show when={!content.loading && !content.error && html()}>
            <article class="md-rendered" innerHTML={html()} />
          </Show>
        </div>
      </div>
    </div>
  );
}
