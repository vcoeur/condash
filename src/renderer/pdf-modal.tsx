import { createResource, Show } from 'solid-js';
import { Modal } from './modal';
import './pdf-modal.css';

export function PdfModal(props: {
  path: string;
  onClose: () => void;
  onOpenInOs: (path: string) => void;
  onReveal: (path: string) => void;
}) {
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
    <Modal
      class="pdf-modal"
      ariaLabel={`PDF: ${resolved()?.filename ?? 'document'}`}
      title={resolved()?.filename ?? ''}
      path={props.path}
      onClose={props.onClose}
      headExtra={
        <>
          <button
            class="modal-button"
            onClick={() => props.onReveal(props.path)}
            title="Reveal in file manager"
          >
            ⤷
          </button>
          <button
            class="modal-button"
            onClick={() => props.onOpenInOs(props.path)}
            title="Open in OS default viewer"
          >
            ↗
          </button>
        </>
      }
    >
      <div class="pdf-body">
        <Show when={resolved()?.url}>
          {(url) => (
            // Harden the embedded webview that renders the PDF:
            //   - `webpreferences=...` keeps Node off, isolates the
            //     context, and runs the renderer in the OS sandbox.
            // A defence-in-depth `web-contents-created` handler in
            // main/index.ts re-applies these settings if a future
            // webview ships without the attribute.
            //
            // Deliberately NO `partition`: Chromium's built-in PDF
            // viewer is a component extension registered only in the
            // default session, so a custom partition loads the viewer
            // chrome (scrollbars) but never paints the pages — a blank
            // PDF. The webview only ever loads a local, path-validated
            // `file://` PDF that sets no cookies or localStorage, so a
            // partition would isolate nothing while breaking rendering.
            <webview
              src={url()}
              class="pdf-webview"
              webpreferences="contextIsolation=true,nodeIntegration=false,sandbox=true"
            />
          )}
        </Show>
      </div>
    </Modal>
  );
}
