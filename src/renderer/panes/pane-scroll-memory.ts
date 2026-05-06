import { onCleanup } from 'solid-js';

/**
 * Per-pane in-session scroll-position memory.
 *
 * The composite layout swaps the working surface between Code / Knowledge /
 * Resources / Skills (and toggles Projects), so flipping panes unmounts
 * the previous one and remounts the new. Without this hook the pane
 * always re-mounts at scrollTop 0, which is annoying when the user is
 * deep into a long Knowledge tree and flips to Code to grab a path.
 *
 * Module-level Map: lives for the lifetime of the renderer process. Not
 * persisted across launches — saving scroll positions to settings.json
 * would carry too much per-session noise.
 */
const positions = new Map<string, number>();

/**
 * Solid hook: returns a ref callback. Pass it to the pane's scroll
 * container. On mount, restores the saved scrollTop (if any). On
 * unmount, captures the current scrollTop into the module-level Map.
 */
export function usePaneScrollMemory(paneId: string): (el: HTMLElement | undefined) => void {
  let scroller: HTMLElement | undefined;

  const ref = (el: HTMLElement | undefined): void => {
    scroller = el;
    if (!el) return;
    const saved = positions.get(paneId);
    if (saved !== undefined) {
      // queueMicrotask so the restore happens after the pane's children
      // have laid out — otherwise scrollTop assignment hits an empty
      // container and silently no-ops.
      queueMicrotask(() => {
        if (scroller === el) el.scrollTop = saved;
      });
    }
  };

  onCleanup(() => {
    if (scroller) positions.set(paneId, scroller.scrollTop);
  });

  return ref;
}
