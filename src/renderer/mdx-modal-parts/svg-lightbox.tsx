import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Modal } from '../modal';
import { Button } from '../actions';
import { scopeCss } from './data';
import { standaloneSvg } from './sanitize';

/** What the svg block hands the lightbox: sanitized markup, the block's CSS,
 *  and the names the save dialog and the title are seeded with. */
export interface SvgLightboxPayload {
  /** Already-sanitized `<svg>` markup, exactly what the block drew. */
  svg: string;
  /** The block's optional ```css fence, unscoped. */
  css?: string;
  /** Head title: the caption, the alt, or a neutral fallback. */
  title: string;
  /** Default path the save dialog opens on (`<note-stem>-<id>.svg`). */
  defaultPath: string;
}

/**
 * Full-size view of one svg block, with Download .svg and Copy SVG. Rendered
 * through a Portal on `document.body` so the modal's own `transform`
 * animation never captures the fixed backdrop, and it paints above every
 * overlay inside `#root`. Esc handling is explained on `onKey`.
 */
export function SvgLightbox(props: { payload: SvgLightboxPayload; onClose: () => void }) {
  const [fit, setFit] = createSignal(true);
  const [savedAt, setSavedAt] = createSignal<number | null>(null);
  const [copiedAt, setCopiedAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const scopeId = 'svg-lightbox-scope';

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    // While mounted, the lightbox is what the reader sees on top: it is
    // portalled to `document.body` after `#root`, where every other overlay
    // renders, and all backdrops share one z-index — so a search or shortcuts
    // overlay opened meanwhile paints *under* it. Esc therefore belongs to the
    // lightbox for as long as it exists; the next Esc reaches whatever is
    // left. Intercepted on `window` capture and stopped here because the
    // shared `Modal` shell registers its Esc-to-close on `document` and two
    // shells are mounted — without this, one Esc would close the note too.
    event.preventDefault();
    event.stopImmediatePropagation();
    props.onClose();
  };
  onMount(() => window.addEventListener('keydown', onKey, true));
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  let pillTimer: ReturnType<typeof setTimeout> | null = null;
  const flash = (set: (value: number | null) => void): void => {
    set(Date.now());
    if (pillTimer !== null) clearTimeout(pillTimer);
    pillTimer = setTimeout(() => {
      setSavedAt(null);
      setCopiedAt(null);
      pillTimer = null;
    }, 1500);
  };
  onCleanup(() => {
    if (pillTimer !== null) clearTimeout(pillTimer);
  });

  const fileText = (): string => standaloneSvg(props.payload.svg, props.payload.css);

  const download = async (): Promise<void> => {
    setError(null);
    try {
      const saved = await window.condash.saveSvg(props.payload.defaultPath, fileText());
      if (saved) flash(setSavedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const copy = async (): Promise<void> => {
    setError(null);
    try {
      await navigator.clipboard.writeText(fileText());
      flash(setCopiedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Portal mount={document.body}>
      <Modal
        class="image-modal svg-lightbox"
        backdropClass="svg-lightbox-backdrop"
        ariaLabel={`Diagram: ${props.payload.title}`}
        title={props.payload.title}
        onClose={props.onClose}
        headExtra={
          <>
            <div class="modal-seg" role="tablist" aria-label="Diagram zoom">
              <Button
                type="button"
                role="tab"
                variant="default"
                classList={{ active: fit() }}
                aria-selected={fit()}
                onClick={() => setFit(true)}
                title="Fit the window"
              >
                Fit
              </Button>
              <Button
                type="button"
                role="tab"
                variant="default"
                classList={{ active: !fit() }}
                aria-selected={!fit()}
                onClick={() => setFit(false)}
                title="Natural size"
              >
                1:1
              </Button>
            </div>
            <Show when={savedAt() !== null}>
              <span class="modal-saved" title="SVG saved" aria-label="SVG saved">
                ✓
              </span>
            </Show>
            <Show when={copiedAt() !== null}>
              <span class="modal-saved" title="SVG copied" aria-label="SVG copied">
                ✓
              </span>
            </Show>
            {/* Text buttons: the 32 px `.btn--modal-head` idiom is for glyphs. */}
            <Button
              variant="default"
              class="svg-lightbox-action"
              onClick={() => void copy()}
              title="Copy the SVG markup"
            >
              Copy SVG
            </Button>
            <Button
              variant="default"
              class="svg-lightbox-action"
              onClick={() => void download()}
              title="Save the diagram as a standalone .svg file"
            >
              Download .svg
            </Button>
          </>
        }
      >
        <Show when={error()}>
          <div class="modal-error" role="alert">
            {error()}
          </div>
        </Show>
        <div class="image-body svg-lightbox-body" classList={{ 'svg-lightbox-natural': !fit() }}>
          <Show when={props.payload.css}>
            <style>{scopeCss(props.payload.css!, `#${scopeId}`)}</style>
          </Show>
          <div id={scopeId} class="plan-svg-card svg-lightbox-card" innerHTML={props.payload.svg} />
        </div>
      </Modal>
    </Portal>
  );
}
