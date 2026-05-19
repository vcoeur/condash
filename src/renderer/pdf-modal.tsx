import { createResource, Show } from 'solid-js';
import { useModalEscHandler } from './modal-helpers';
import './pdf-modal.css';

export function PdfModal(props: {
  path: string;
  onClose: () => void;
  onOpenInOs: (path: string) => void;
}) {
  useModalEscHandler(props.onClose);

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
        aria-label={`PDF: ${resolved()?.filename ?? 'document'}`}
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
            {(url) => (
              // Lockdown the embedded webview that renders the PDF:
              //   - `partition="pdfs"` isolates session storage so no
              //     cookies / localStorage spill into the main session.
              //   - `webpreferences=...` keeps Node off, isolates the
              //     context, and runs the renderer in the OS sandbox.
              // A defence-in-depth `web-contents-created` handler in
              // main/index.ts also re-applies these settings if a
              // future webview ships without the attribute.
              <webview
                src={url()}
                class="pdf-webview"
                partition="pdfs"
                webpreferences="contextIsolation=true,nodeIntegration=false,sandbox=true"
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
