import { createEffect, onCleanup } from 'solid-js';

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
 *
 * The `paneId` argument may be a plain string or a getter. A getter lets
 * callers thread a reactive sub-id (e.g. the active Skills tab) so the
 * hook saves the current scrollTop under the previous id and restores
 * the next id's position in the same scroller — no remount required.
 */
const positions = new Map<string, number>();

export function usePaneScrollMemory(
  paneId: string | (() => string),
): (el: HTMLElement | undefined) => void {
  let scroller: HTMLElement | undefined;
  let lastId: string | undefined;

  const resolveId = (): string => (typeof paneId === 'string' ? paneId : paneId());

  const ref = (el: HTMLElement | undefined): void => {
    scroller = el;
    if (!el) return;
    const id = resolveId();
    lastId = id;
    const saved = positions.get(id);
    if (saved !== undefined) {
      // queueMicrotask so the restore happens after the pane's children
      // have laid out — otherwise scrollTop assignment hits an empty
      // container and silently no-ops.
      queueMicrotask(() => {
        if (scroller === el) el.scrollTop = saved;
      });
    }
  };

  // Reactively follow `paneId` changes when a getter is passed: save the
  // current scrollTop under the *previous* id, then restore the new id's
  // position. The first invocation only records the initial id.
  if (typeof paneId !== 'string') {
    createEffect(() => {
      const nextId = paneId();
      if (!scroller) {
        lastId = nextId;
        return;
      }
      if (lastId !== undefined && lastId !== nextId) {
        positions.set(lastId, scroller.scrollTop);
      }
      lastId = nextId;
      const saved = positions.get(nextId);
      queueMicrotask(() => {
        if (scroller) scroller.scrollTop = saved ?? 0;
      });
    });
  }

  onCleanup(() => {
    if (scroller && lastId !== undefined) positions.set(lastId, scroller.scrollTop);
  });

  return ref;
}
