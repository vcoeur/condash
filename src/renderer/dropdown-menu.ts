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
  /** Close programmatically (e.g. after picking a menu item). */
  close: () => void;
}

/**
 * Solid hook that drives a click-to-open dropdown menu portal'd against
 * a trigger button. Pulled out of `panes/code.tsx` where the same
 * positionMenu / onDocClick / onScrollOrResize dance was duplicated
 * across `RepoCardMenu` and `BranchActions`.
 *
 * Anchor shape: `top = trigger.bottom + 4`, `left = trigger.right`.
 * Callers are expected to apply `transform: translateX(-100%)` in CSS so
 * the menu's right edge lines up with the trigger's right edge — this
 * keeps right-column cards inside the viewport. If the rendered menu
 * would overflow the viewport bottom, the helper flips the anchor above
 * the trigger automatically.
 */
export function createDropdownMenu(): DropdownMenu {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<MenuAnchor | null>(null);
  let triggerEl: HTMLElement | undefined;
  let menuEl: HTMLElement | undefined;

  const positionMenu = (): void => {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const margin = 8;
    let top = rect.bottom + 4;
    const menuH = menuEl?.getBoundingClientRect().height ?? 0;
    if (menuH > 0 && top + menuH > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - 4 - menuH);
    }
    setAnchor({ top, left: rect.right });
  };

  const onDocClick = (e: MouseEvent): void => {
    if (!open()) return;
    const target = e.target as Node;
    if (triggerEl?.contains(target)) return;
    if (menuEl?.contains(target)) return;
    setOpen(false);
  };

  const onScrollOrResize = (): void => {
    if (open()) positionMenu();
  };

  // Esc closes the open menu — keyboard-only users would otherwise be
  // stuck after triggering the dropdown (no obvious way to cancel without
  // a click outside). Capture phase + stopPropagation so we don't also
  // fire the parent modal/popover's Esc handler when stacked.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!open()) return;
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
    isOpen: open,
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
      if (open()) {
        setOpen(false);
        return;
      }
      positionMenu();
      setOpen(true);
    },
    close: () => setOpen(false),
  };
}
