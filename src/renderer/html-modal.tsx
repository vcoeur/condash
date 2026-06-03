import { createResource, createSignal, Show } from 'solid-js';
import { useModalEscHandler } from './modal-helpers';
import { highlightCode, pathToCondashFileUrl } from './markdown';
import './html-modal.css';

type HtmlMode = 'rendered' | 'source';

/**
 * In-app preview for a local HTML file. Two modes via the header toggle:
 *   - Rendered — a sandboxed `<webview>` loading the page over the
 *     conception-sandboxed `condash-file://` protocol, so relative references
 *     (`<img src="sibling.jpg">`, relative CSS/JS) resolve against the file's
 *     own directory. Root-absolute (`/assets/…`) and remote assets may not load
 *     under the renderer CSP — the open-in-OS button is the fallback for those.
 *   - Source — the raw markup, syntax-highlighted (read via `readNote`, which
 *     is conception-bounded like every file the tree surfaces).
 *
 * The header also reveals the file in the OS file manager and opens it in the
 * OS default browser.
 */
export function HtmlModal(props: {
  path: string;
  onClose: () => void;
  onOpenInOs: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  useModalEscHandler(props.onClose);

  const [mode, setMode] = createSignal<HtmlMode>('rendered');

  const filename = (): string => props.path.split('/').pop() ?? props.path;
  const url = (): string => pathToCondashFileUrl(props.path);

  // Only read the source when the Source tab is active.
  const [source] = createResource(
    () => (mode() === 'source' ? props.path : null),
    (path) => window.condash.readNote(path),
  );
  // highlight.js is lazy-loaded (out of the boot chunk); resource, not memo.
  const [sourceHtml] = createResource(source, async (text) =>
    text == null ? '' : highlightCode(text, props.path),
  );

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
          <div class="modal-seg" role="tablist" aria-label="HTML view mode">
            <button
              type="button"
              role="tab"
              class="modal-button modal-button--text"
              classList={{ active: mode() === 'rendered' }}
              aria-selected={mode() === 'rendered'}
              onClick={() => setMode('rendered')}
            >
              Rendered
            </button>
            <button
              type="button"
              role="tab"
              class="modal-button modal-button--text"
              classList={{ active: mode() === 'source' }}
              aria-selected={mode() === 'source'}
              onClick={() => setMode('source')}
            >
              Source
            </button>
          </div>
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
            title="Open in OS default browser"
          >
            ↗
          </button>
          <button class="modal-button modal-close" onClick={props.onClose} title="Close (Esc)">
            ×
          </button>
        </header>
        <div class="html-body">
          <Show
            when={mode() === 'rendered'}
            fallback={
              <div class="html-source md-rendered raw-code" innerHTML={sourceHtml() ?? ''} />
            }
          >
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
          </Show>
        </div>
      </div>
    </div>
  );
}
