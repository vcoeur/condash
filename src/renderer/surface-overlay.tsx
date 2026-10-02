import { onCleanup, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createBackdropClose } from './modal-helpers';
import './surface-overlay.css';

/** Full-window utility shell. Child dialogs own Escape before the parent. */
export function SurfaceOverlay(props: {
  title: string;
  childOpen: () => boolean;
  onFocusReturn: () => void;
  onClose: () => void;
  children: JSX.Element;
}): JSX.Element {
  let panel!: HTMLDivElement;
  const backdrop = createBackdropClose(props.onClose);
  const lastFocused = new WeakMap<HTMLElement, HTMLElement>();
  // Modal children live within this portal. Resolve the deepest visible dialog
  // on each event so confirmations trap focus instead of the full-window parent.
  const activeDialog = (): HTMLElement =>
    [...panel.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
      .filter((el) => el.getClientRects().length > 0)
      .at(-1) ?? panel;
  const focusable = (dialog: HTMLElement): HTMLElement[] =>
    [...dialog.querySelectorAll<HTMLElement>('*')]
      .filter(
        (el) =>
          el.tabIndex >= 0 &&
          !el.matches(':disabled') &&
          !el.closest('[inert]') &&
          el.getClientRects().length > 0 &&
          getComputedStyle(el).visibility === 'visible' &&
          el.closest('[role="dialog"], [role="alertdialog"]') === dialog,
      )
      .sort((left, right) => (left.tabIndex || Infinity) - (right.tabIndex || Infinity));
  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !props.childOpen()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      props.onClose();
    }
    if (event.key !== 'Tab') return;
    const dialog = activeDialog();
    const controls = focusable(dialog);
    const index = controls.indexOf(document.activeElement as HTMLElement);
    if (index === -1 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  };
  const containFocus = (event: FocusEvent): void => {
    const dialog = activeDialog();
    const target = event.target as HTMLElement;
    if (dialog.contains(target)) lastFocused.set(dialog, target);
    else (focusable(dialog)[0] ?? dialog).focus();
  };
  onMount(() => {
    panel.querySelector<HTMLButtonElement>('.surface-back')?.focus();
    // Window capture precedes document handlers: inspect child ownership before
    // a child's document listener can close it in this same key event.
    window.addEventListener('keydown', handleKey, true);
    document.addEventListener('focusin', containFocus);
    const observer = new MutationObserver(() => {
      const dialog = activeDialog();
      if (!dialog.contains(document.activeElement)) {
        const previous = lastFocused.get(dialog);
        (previous?.isConnected ? previous : (focusable(dialog)[0] ?? dialog)).focus();
      }
    });
    observer.observe(panel, { childList: true, subtree: true });
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => {
    window.removeEventListener('keydown', handleKey, true);
    document.removeEventListener('focusin', containFocus);
    props.onFocusReturn();
  });
  return (
    <Portal>
      <div class="surface-backdrop" {...backdrop}>
        <div
          ref={panel}
          class="surface-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          tabindex={-1}
        >
          <header class="modal-head">
            <button class="surface-back btn btn--default" onClick={props.onClose}>
              ← Back
            </button>
            <span class="modal-title">{props.title}</span>
          </header>
          <div class="surface-body">{props.children}</div>
        </div>
      </div>
    </Portal>
  );
}
