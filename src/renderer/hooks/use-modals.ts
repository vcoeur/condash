import { createSignal, type Setter } from 'solid-js';
import type { RepoEntry, LogsOpenRequest } from '@shared/types';
import type { ModalState } from '../modal-types';
import type { HelpDoc } from '../help-modal';

/**
 * Single "which singleton overlay is open" model. The menu- / keyboard-opened
 * overlays that are mutually exclusive and carry no router state — search,
 * settings, new-project, about, quit-confirm, shortcuts, and the bundled help
 * doc — are one discriminated union behind a single signal, so the
 * "only one of these is open at a time" invariant lives in one place instead
 * of being implicit across a bag of booleans. `null` = none open.
 *
 * The payload-carrying, router-coupled surfaces (the note `modal`, the project
 * `previewPath`, the pdf/html/image file viewers, the prompt, and the
 * init/force-stop confirms) keep their own signals: they hold state and the
 * modal-router's back-stack / preview-restore wiring reads and writes them
 * independently, so collapsing them into this union would entangle the router.
 */
export type ActiveModal =
  | { kind: 'search' }
  | { kind: 'settings' }
  | { kind: 'newProject' }
  | { kind: 'about' }
  | { kind: 'quitConfirm' }
  | { kind: 'shortcuts' }
  | { kind: 'help'; doc: HelpDoc }
  | null;

export interface UseModals {
  modal: () => ModalState;
  setModal: Setter<ModalState>;
  previewPath: () => string | null;
  setPreviewPath: Setter<string | null>;
  pdfPath: () => string | null;
  setPdfPath: Setter<string | null>;
  htmlPath: () => string | null;
  setHtmlPath: Setter<string | null>;
  imagePath: () => string | null;
  setImagePath: Setter<string | null>;
  mdxPath: () => string | null;
  setMdxPath: Setter<string | null>;
  /** The single active-overlay signal backing the boolean accessors below. */
  activeModal: () => ActiveModal;
  setActiveModal: Setter<ActiveModal>;
  helpDoc: () => HelpDoc | null;
  setHelpDoc: (doc: HelpDoc | null) => void;
  searchModalOpen: () => boolean;
  setSearchModalOpen: (open: boolean) => void;
  settingsOpen: () => boolean;
  setSettingsOpen: (open: boolean) => void;
  newProjectOpen: () => boolean;
  setNewProjectOpen: (open: boolean) => void;
  aboutOpen: () => boolean;
  setAboutOpen: (open: boolean) => void;
  quitConfirmOpen: () => boolean;
  setQuitConfirmOpen: (open: boolean) => void;
  shortcutsOpen: () => boolean;
  setShortcutsOpen: (next: boolean | ((cur: boolean) => boolean)) => void;
  noteDirty: () => boolean;
  setNoteDirty: Setter<boolean>;
  initConfirmState: () => { path: string; missing: string[] } | null;
  setInitConfirmState: Setter<{ path: string; missing: string[] } | null>;
  forceStopState: () => RepoEntry | null;
  setForceStopState: Setter<RepoEntry | null>;
  /** Logs pane: external "open this session" requests posted by the
   *  global-search modal. Carries a path + nonce so reactivating the
   *  same session twice in a row still triggers the pane's effect. */
  logsOpenRequest: () => LogsOpenRequest | null;
  setLogsOpenRequest: Setter<LogsOpenRequest | null>;
  nextLogsOpenNonce: () => number;
}

/** Modal + transient overlay signal bag. Holds the open-state for every
 *  modal the App component composes; passed around as a unit so callers
 *  don't carry a dozen individual setters. The singleton overlays share one
 *  `activeModal` discriminated union (see ActiveModal); the boolean accessors
 *  are thin derived views over it so existing call sites stay unchanged. */
export function useModals(): UseModals {
  const [modal, setModal] = createSignal<ModalState>(null);
  const [previewPath, setPreviewPath] = createSignal<string | null>(null);
  const [pdfPath, setPdfPath] = createSignal<string | null>(null);
  const [htmlPath, setHtmlPath] = createSignal<string | null>(null);
  const [imagePath, setImagePath] = createSignal<string | null>(null);
  const [mdxPath, setMdxPath] = createSignal<string | null>(null);
  const [activeModal, setActiveModal] = createSignal<ActiveModal>(null);
  const [noteDirty, setNoteDirty] = createSignal(false);
  const [initConfirmState, setInitConfirmState] = createSignal<{
    path: string;
    missing: string[];
  } | null>(null);
  const [forceStopState, setForceStopState] = createSignal<RepoEntry | null>(null);
  const [logsOpenRequest, setLogsOpenRequest] = createSignal<LogsOpenRequest | null>(null);
  let logsOpenNonce = 0;
  const nextLogsOpenNonce = (): number => ++logsOpenNonce;

  // Toggle one singleton overlay on/off. Opening any overlay implicitly
  // closes whichever was open (mutual exclusion); closing only clears the
  // signal when *this* overlay is the active one, so a stale `setX(false)`
  // can't tear down a different overlay that opened in the meantime.
  const isOpen = (kind: NonNullable<ActiveModal>['kind']): boolean => activeModal()?.kind === kind;
  const setOpen = (
    kind: Exclude<NonNullable<ActiveModal>['kind'], 'help'>,
    open: boolean,
  ): void => {
    if (open) setActiveModal({ kind });
    else if (isOpen(kind)) setActiveModal(null);
  };

  const helpDoc = (): HelpDoc | null => {
    const m = activeModal();
    return m?.kind === 'help' ? m.doc : null;
  };
  const setHelpDoc = (doc: HelpDoc | null): void => {
    if (doc) setActiveModal({ kind: 'help', doc });
    else if (isOpen('help')) setActiveModal(null);
  };

  return {
    modal,
    setModal,
    previewPath,
    setPreviewPath,
    pdfPath,
    setPdfPath,
    htmlPath,
    setHtmlPath,
    imagePath,
    setImagePath,
    mdxPath,
    setMdxPath,
    activeModal,
    setActiveModal,
    helpDoc,
    setHelpDoc,
    searchModalOpen: () => isOpen('search'),
    setSearchModalOpen: (open) => setOpen('search', open),
    settingsOpen: () => isOpen('settings'),
    setSettingsOpen: (open) => setOpen('settings', open),
    newProjectOpen: () => isOpen('newProject'),
    setNewProjectOpen: (open) => setOpen('newProject', open),
    aboutOpen: () => isOpen('about'),
    setAboutOpen: (open) => setOpen('about', open),
    quitConfirmOpen: () => isOpen('quitConfirm'),
    setQuitConfirmOpen: (open) => setOpen('quitConfirm', open),
    shortcutsOpen: () => isOpen('shortcuts'),
    setShortcutsOpen: (next) =>
      setOpen('shortcuts', typeof next === 'function' ? next(isOpen('shortcuts')) : next),
    noteDirty,
    setNoteDirty,
    initConfirmState,
    setInitConfirmState,
    forceStopState,
    setForceStopState,
    logsOpenRequest,
    setLogsOpenRequest,
    nextLogsOpenNonce,
  };
}
