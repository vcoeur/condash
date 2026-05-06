import { createSignal, onCleanup, onMount } from 'solid-js';

export interface PopoverAnchor {
  top: number;
  left: number;
}

export interface PositionedPopover {
  open: () => boolean;
  setOpen: (next: boolean) => void;
  anchor: () => PopoverAnchor | null;
  /** Re-measure the active trigger and reposition. The caller should
   *  invoke this after any content change that could resize the popover
   *  (so a flip-above decision happens with the *real* height). */
  reposition: () => void;
  /** Set the trigger element the popover should anchor against. Must be
   *  called before open/reposition; setting null clears the anchor. */
  setActiveTrigger: (el: HTMLElement | null) => void;
}

export interface PopoverOptions {
  /** Required: the popover element ref. The hook re-measures its height
   *  on every reposition to decide between below-anchor and above-anchor. */
  popoverRef: () => HTMLElement | undefined;
  /** Trigger refs the document-click handler treats as in-popover (so a
   *  click on the trigger doesn't immediately close). Pass any number. */
  triggerRefs: () => readonly (HTMLElement | undefined)[];
  /** Called when the popover should close (Escape, outside-click, etc.). */
  onClose: () => void;
  /** Pixels of margin to keep between the popover and the viewport edge
   *  when flipping. Default 8. */
  edgeMargin?: number;
  /** Pixels between the trigger and the popover. Default 4. */
  gap?: number;
}

/**
 * Anchor + lifecycle hook for the position-fixed popovers used by the
 * code tab (dirty + upstream popovers, branch info popover, future
 * action menus). Encapsulates:
 *
 *   - measuring the active trigger to anchor the popover below it,
 *   - flipping above when the rendered popover would overflow the
 *     viewport bottom,
 *   - global click / Escape / resize / scroll handlers that close or
 *     reposition the popover.
 *
 * Callers pass refs in by callback (so the hook reads them lazily) and
 * call `setActiveTrigger(el)` immediately before `setOpen(true)`. The
 * `reposition()` helper should run on every content change so an async
 * payload that grows the popover triggers the flip-above decision with
 * its real height.
 */
export function createPositionedPopover(opts: PopoverOptions): PositionedPopover {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<PopoverAnchor | null>(null);
  const edgeMargin = opts.edgeMargin ?? 8;
  const gap = opts.gap ?? 4;
  let activeTrigger: HTMLElement | null = null;

  const reposition = (): void => {
    if (!activeTrigger) return;
    const rect = activeTrigger.getBoundingClientRect();
    let top = rect.bottom + gap;
    const popH = opts.popoverRef()?.getBoundingClientRect().height ?? 0;
    if (popH > 0 && top + popH > window.innerHeight - edgeMargin) {
      top = Math.max(edgeMargin, rect.top - gap - popH);
    }
    setAnchor({ top, left: rect.left });
  };

  const onDocClick = (e: MouseEvent): void => {
    if (!open()) return;
    const target = e.target as Node;
    const triggers = opts.triggerRefs();
    for (const t of triggers) {
      if (t?.contains(target)) return;
    }
    if (opts.popoverRef()?.contains(target)) return;
    opts.onClose();
  };

  const onScrollOrResize = (): void => {
    if (open()) reposition();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && open()) opts.onClose();
  };

  onMount(() => {
    document.addEventListener('click', onDocClick, true);
    // Capture phase so the popover sees Esc before any inner input
    // swallows it — matches the click listener and the modal handlers.
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onScrollOrResize, true);
    window.addEventListener('scroll', onScrollOrResize, true);
  });
  onCleanup(() => {
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onScrollOrResize, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
  });

  return {
    open,
    setOpen,
    anchor,
    reposition,
    setActiveTrigger: (el) => {
      activeTrigger = el;
    },
  };
}
