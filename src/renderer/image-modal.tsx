import { createSignal, Show } from 'solid-js';
import { useModalEscHandler } from './modal-helpers';
import { pathToCondashFileUrl } from './markdown';
import './image-modal.css';

/**
 * In-app preview for a local image (raster or SVG). Mirrors `PdfModal` /
 * `HtmlModal`: the image is served over the conception-sandboxed
 * `condash-file://` protocol and shown fit-to-window. The header carries
 * reveal-in-file-manager + open-in-OS escape hatches.
 *
 * An image that resolves outside the conception tree is rejected by the
 * protocol handler (the same constraint as the HTML / PDF viewers); the
 * `onError` fallback points the user at the open-externally button.
 */
export function ImageModal(props: {
  path: string;
  onClose: () => void;
  onOpenInOs: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  useModalEscHandler(props.onClose);

  const filename = (): string => props.path.split('/').pop() ?? props.path;
  const url = (): string => pathToCondashFileUrl(props.path);
  const [errored, setErrored] = createSignal(false);

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal image-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Image: ${filename()}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">{filename()}</span>
          <span class="modal-path">{props.path}</span>
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
          <button class="modal-button modal-close" onClick={props.onClose} title="Close (Esc)">
            ×
          </button>
        </header>
        <div class="image-body">
          <Show
            when={!errored()}
            fallback={
              <div class="image-error">
                Could not load this image in-app. It may live outside the conception tree — use
                “open in OS default viewer” above.
              </div>
            }
          >
            <img class="image-view" src={url()} alt={filename()} onError={() => setErrored(true)} />
          </Show>
        </div>
      </div>
    </div>
  );
}
