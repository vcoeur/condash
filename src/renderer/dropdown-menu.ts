import { createSignal, onCleanup, onMount } from 'solid-js';

interface MenuAnchor {
  top: number;
  left: number;
}

interface DropdownMenu {
  /** Open or close the menu. */
  isOpen: () => boolean;
  /** Anchor coords (top/left of the portal'd menu) — null while closed. */
  anchor: () => MenuAnchor | null;
  /** Wire the trigger's `ref={…}` callback. */
  setTrigger: (el: HTMLElement | undefined) => void;
  /** Wire the portal'd menu's `ref={…}` callback — the helper re-runs
   *  positionMenu after mount so it can flip above when the menu's
   *  rendered height would otherwise spill below the viewport. */
  setMenu: (el: HTMLElement | undefined) => void;
  /** Toggle the menu — pass the click event so propagation stops. */
  toggle: (e: MouseEvent) => void;
  /** Open the menu programmatically (e.g. from a keyboard handler that
   *  already swallowed the event). */
  open: () => void;
  /** Close programmatically (e.g. after picking a menu item). */
  close: () => void;
}

export interface CreateDropdownMenuOptions {
  /** Which edge of the trigger to anchor the menu to. Default `right` —
   *  the menu's right edge lines up with the trigger's right edge (callers
   *  apply `transform: translateX(-100%)` in CSS). With `left`, the menu's
   *  left edge aligns with the trigger's left edge (no transform needed),
   *  which fits triggers in the left part of the viewport — e.g. the
   *  terminal strip's spawn dropdown. */
  align?: 'left' | 'right';
}

/**
 * Solid hook that drives a click-to-open dropdown menu portal'd against
 * a trigger button. Pulled out of `panes/code.tsx` where the same
 * positionMenu / onDocClick / onScrollOrResize dance was duplicated
 * across `RepoCardMenu` and `BranchActions`.
 *
 * Default (right-aligned): `top = trigger.bottom + 4`, `left =
 * trigger.right`. Callers apply `transform: translateX(-100%)` so the
 * menu's right edge lines up with the trigger's right edge. With
 * `align: 'left'`, the anchor is `left = trigger.left` and no transform
 * is needed.
 *
 * If the rendered menu would overflow the viewport bottom, the helper
 * flips the anchor above the trigger automatically.
 */
export function createDropdownMenu(options: CreateDropdownMenuOptions = {}): DropdownMenu {
  const align = options.align ?? 'right';
  const [openSig, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<MenuAnchor | null>(null);
  let triggerEl: HTMLElement | undefined;
  let menuEl: HTMLElement | undefined;

  const positionMenu = (): void => {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const margin = 8;
    // 8 px gap (was 4 px) so the menu doesn't visually merge with the
    // trigger button; matches the "+ New project" button's visual rhythm.
    const gap = 8;
    let top = rect.bottom + gap;
    const menuH = menuEl?.getBoundingClientRect().height ?? 0;
    if (menuH > 0 && top + menuH > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - gap - menuH);
    }
    const left = align === 'left' ? rect.left : rect.right;
    // De-dupe so an unchanged position does not emit. The menu body in
    // action-split-button.tsx reads `anchor()` inside a JSX expression
    // slot (an IIFE that returns the menu div); Solid wraps the slot in
    // a reactive computation, so any emit re-runs the IIFE — recreating
    // the menu div *and every child <button>*. `setMenu` then re-schedules
    // positionMenu via requestAnimationFrame on the new mount, which used
    // to setAnchor with a fresh object even for identical coordinates →
    // infinite re-render → menu items detach between mousedown and mouseup
    // → clicks never fire. This guard breaks the loop.
    const current = anchor();
    if (current && current.top === top && current.left === left) return;
    setAnchor({ top, left });
  };

  const onDocClick = (e: MouseEvent): void => {
    if (!openSig()) return;
    const target = e.target as Node;
    if (triggerEl?.contains(target)) return;
    if (menuEl?.contains(target)) return;
    setOpen(false);
  };

  const onScrollOrResize = (): void => {
    if (openSig()) positionMenu();
  };

  // Esc closes the open menu — keyboard-only users would otherwise be
  // stuck after triggering the dropdown (no obvious way to cancel without
  // a click outside). Capture phase + stopPropagation so we don't also
  // fire the parent modal/popover's Esc handler when stacked.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!openSig()) return;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  };

  onMount(() => {
    document.addEventListener('click', onDocClick, true);
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
    isOpen: openSig,
    anchor,
    setTrigger: (el) => {
      triggerEl = el;
    },
    setMenu: (el) => {
      menuEl = el;
      // Re-position with the actual rendered height so we can flip above
      // the trigger when the menu would otherwise spill below the
      // viewport (e.g. card sitting near the bottom of the page).
      if (el) requestAnimationFrame(positionMenu);
    },
    toggle: (e: MouseEvent): void => {
      e.stopPropagation();
      if (openSig()) {
        setOpen(false);
        return;
      }
      positionMenu();
      setOpen(true);
    },
    open: () => {
      if (openSig()) return;
      positionMenu();
      setOpen(true);
    },
    close: () => setOpen(false),
  };
}
