import { createSignal, Show } from 'solid-js';
import { Modal } from './modal';
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
  const filename = (): string => props.path.split('/').pop() ?? props.path;
  const url = (): string => pathToCondashFileUrl(props.path);
  const [errored, setErrored] = createSignal(false);

  return (
    <Modal
      class="image-modal"
      ariaLabel={`Image: ${filename()}`}
      title={filename()}
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
      <div class="image-body">
        <Show
          when={!errored()}
          fallback={
            <div class="image-error">
              Could not load this image in-app. It may live outside the conception tree — use “open
              in OS default viewer” above.
            </div>
          }
        >
          <img class="image-view" src={url()} alt={filename()} onError={() => setErrored(true)} />
        </Show>
      </div>
    </Modal>
  );
}
