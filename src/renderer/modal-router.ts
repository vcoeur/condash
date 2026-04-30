import { createSignal } from 'solid-js';
import type { ModalState } from './note-modal';

/** Display label for a modal state — used to render "← Back to <X>" on
 *  the next note's back button when the user navigates deeper. */
function modalLabel(m: NonNullable<ModalState>): string {
  if (m.title) return m.title;
  const base = m.path.split('/').pop();
  return base && base.length > 0 ? base : m.path;
}

export interface ModalRouterDeps {
  /** Read the currently-displayed modal state. */
  modal: () => ModalState;
  /** Set the currently-displayed modal state. */
  setModal: (next: ModalState) => void;
  /** Set the PDF preview path (closing it = setting null). */
  setPdfPath: (next: string | null) => void;
  /** Set the project preview path (used to restore from a child modal). */
  setPreviewPath: (next: string | null) => void;
}

export interface ModalRouter {
  previewBackPath: () => string | null;
  setPreviewBackPath: (next: string | null) => void;
  /** Push the current modal onto the stack and open `next` in its place,
   *  filling in `next.backLabel` from the previous modal so the chain
   *  unwinds with sensible labels. If no modal is open, just open `next`. */
  navigateInModal: (next: NonNullable<ModalState>) => void;
  /** Pop one entry off the in-modal history. If empty, fall through to the
   *  close path so the back button still works for items opened directly
   *  from a project preview. */
  handleModalBack: () => void;
  /** Any close (× / Esc) is an explicit "leave the reading thread" — wipe
   *  the in-modal history along with the modal itself, then restore the
   *  preview if we came from one. */
  closeChildModal: (clear: () => void) => void;
}

/** Create the in-modal navigation router. Returns a `previewBackPath`
 *  signal pair (so the host can also write to it when opening a fresh
 *  preview from a card) plus the three navigation actions. */
export function createModalRouter(deps: ModalRouterDeps): ModalRouter {
  // In-modal navigation history. Each entry is the modal state we were
  // showing before the user clicked a relative .md link or wikilink. The
  // back button pops one off; close (× / Esc) clears the whole stack.
  const [modalStack, setModalStack] = createSignal<NonNullable<ModalState>[]>([]);
  const [previewBackPath, setPreviewBackPath] = createSignal<string | null>(null);

  const navigateInModal = (next: NonNullable<ModalState>) => {
    const cur = deps.modal();
    if (cur) {
      setModalStack((s) => [...s, cur]);
      deps.setModal({ ...next, backLabel: next.backLabel ?? modalLabel(cur) });
    } else {
      deps.setModal(next);
    }
  };

  const closeChildModal = (clear: () => void) => {
    clear();
    setModalStack([]);
    const back = previewBackPath();
    if (back) {
      setPreviewBackPath(null);
      deps.setPreviewPath(back);
    }
  };

  const handleModalBack = () => {
    const stack = modalStack();
    if (stack.length === 0) {
      closeChildModal(() => deps.setModal(null));
      return;
    }
    const prev = stack[stack.length - 1];
    setModalStack(stack.slice(0, -1));
    deps.setModal(prev);
  };

  return {
    previewBackPath,
    setPreviewBackPath,
    navigateInModal,
    handleModalBack,
    closeChildModal,
  };
}
