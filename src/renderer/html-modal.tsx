import { useModalEscHandler } from './modal-helpers';
import { pathToCondashFileUrl } from './markdown';
import './html-modal.css';

/**
 * In-app preview for a local HTML deliverable. Mirrors `PdfModal`: a sandboxed
 * `<webview>` with an "open externally" escape hatch in the header.
 *
 * Loaded over `condash-file:///<abs>` rather than `file://` so relative
 * references inside the document (e.g. `<img src="sibling.jpg">`, relative CSS
 * / JS) resolve against the deliverable's own directory and are served by the
 * conception-sandboxed protocol handler in main/index.ts. Root-absolute paths
 * (`/assets/...`) and remote assets may not load under the renderer CSP — the
 * "open externally" button is the fallback for those documents.
 */
export function HtmlModal(props: {
  path: string;
  onClose: () => void;
  onOpenExternally: (path: string) => void;
}) {
  useModalEscHandler(props.onClose);

  const filename = (): string => props.path.split('/').pop() ?? props.path;
  const url = (): string => pathToCondashFileUrl(props.path);

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal html-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`HTML: ${filename()}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">{filename()}</span>
          <span class="modal-path">{props.path}</span>
          <button
            class="modal-button"
            onClick={() => props.onOpenExternally(props.path)}
            title="Open in external browser"
          >
            ↗
          </button>
          <button class="modal-button" onClick={props.onClose} title="Close (Esc)">
            ×
          </button>
        </header>
        <div class="html-body">
          {/* Hardened webview: Node off, context isolated, OS-sandboxed. The
              defence-in-depth `web-contents-created` handler in main/index.ts
              re-applies these if the attribute is ever dropped.

              Deliberately NO `partition` — same lesson as the PDF viewer
              (3.19.4): a custom partition runs in a non-default session.
              Worse here, the `condash-file://` protocol handler is registered
              on the *default* session, so a partitioned webview can't resolve
              the document or its relative assets at all (blank). The webview
              only loads a local, conception-sandboxed file. */}
          <webview
            src={url()}
            class="html-webview"
            webpreferences="contextIsolation=true,nodeIntegration=false,sandbox=true"
          />
        </div>
      </div>
    </div>
  );
}
