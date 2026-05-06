import { onCleanup, onMount } from 'solid-js';

/**
 * Wire a capture-phase document `keydown` listener that calls `onClose`
 * on Esc, with `preventDefault` + `stopPropagation` so the same key
 * doesn't fire on a modal stacked beneath.
 *
 * Pass-6 added the stopPropagation in nine modals as a tactical patch;
 * pass-7 extracts the resulting boilerplate so each modal that wants
 * the standard "Esc closes me" shape can call this hook in one line.
 *
 * The note-modal and settings-modal need a richer Esc shape (note's
 * Esc cycles through pending-view-switch / find-bar / dirty / close;
 * settings gates Esc on the unsaved-edits confirm) — those keep their
 * inline handlers. Modals with the simple "Esc → close" contract use
 * this hook.
 */
export function useModalEscHandler(onClose: () => void): void {
  const handleKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));
}
