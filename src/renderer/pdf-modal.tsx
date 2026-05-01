import { createResource, onCleanup, onMount, Show } from 'solid-js';

export function PdfModal(props: {
  path: string;
  onClose: () => void;
  onOpenInOs: (path: string) => void;
}) {
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    document.addEventListener('keydown', handleKey, true);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKey, true);
  });

  // Build the `file://` URL in main via `pathToFileURL`. That's the only
  // path-to-URL conversion that handles Windows drive letters and percent-
  // encoding correctly across all three OSes — doing it in the renderer
  // would either require a Node module (not available in the sandbox) or
  // re-implementing the rules by hand.
  const [resolved] = createResource(
    () => props.path,
    (path) => window.condash.pdfToFileUrl(path),
  );

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal pdf-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">{resolved()?.filename ?? ''}</span>
          <span class="modal-path">{props.path}</span>
          <button
            class="modal-button"
            onClick={() => props.onOpenInOs(props.path)}
            title="Open in OS default viewer"
          >
            ↗
          </button>
          <button class="modal-button" onClick={props.onClose} title="Close (Esc)">
            ×
          </button>
        </header>
        <div class="pdf-body">
          <Show when={resolved()?.url}>
            {(url) => <webview src={url()} partition="persist:pdf" class="pdf-webview" />}
          </Show>
        </div>
      </div>
    </div>
  );
}
