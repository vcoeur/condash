import { createSignal, type Setter } from 'solid-js';
import type { RepoEntry, LogsOpenRequest } from '@shared/types';
import type { ModalState } from '../note-modal';
import type { HelpDoc } from '../help-modal';

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
  helpDoc: () => HelpDoc | null;
  setHelpDoc: Setter<HelpDoc | null>;
  searchModalOpen: () => boolean;
  setSearchModalOpen: Setter<boolean>;
  settingsOpen: () => boolean;
  setSettingsOpen: Setter<boolean>;
  newProjectOpen: () => boolean;
  setNewProjectOpen: Setter<boolean>;
  aboutOpen: () => boolean;
  setAboutOpen: Setter<boolean>;
  quitConfirmOpen: () => boolean;
  setQuitConfirmOpen: Setter<boolean>;
  shortcutsOpen: () => boolean;
  setShortcutsOpen: Setter<boolean>;
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
 *  don't carry a dozen individual setters. */
export function useModals(): UseModals {
  const [modal, setModal] = createSignal<ModalState>(null);
  const [previewPath, setPreviewPath] = createSignal<string | null>(null);
  const [pdfPath, setPdfPath] = createSignal<string | null>(null);
  const [htmlPath, setHtmlPath] = createSignal<string | null>(null);
  const [imagePath, setImagePath] = createSignal<string | null>(null);
  const [helpDoc, setHelpDoc] = createSignal<HelpDoc | null>(null);
  const [searchModalOpen, setSearchModalOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [newProjectOpen, setNewProjectOpen] = createSignal(false);
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const [quitConfirmOpen, setQuitConfirmOpen] = createSignal(false);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
  const [noteDirty, setNoteDirty] = createSignal(false);
  const [initConfirmState, setInitConfirmState] = createSignal<{
    path: string;
    missing: string[];
  } | null>(null);
  const [forceStopState, setForceStopState] = createSignal<RepoEntry | null>(null);
  const [logsOpenRequest, setLogsOpenRequest] = createSignal<LogsOpenRequest | null>(null);
  let logsOpenNonce = 0;
  const nextLogsOpenNonce = (): number => ++logsOpenNonce;

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
    helpDoc,
    setHelpDoc,
    searchModalOpen,
    setSearchModalOpen,
    settingsOpen,
    setSettingsOpen,
    newProjectOpen,
    setNewProjectOpen,
    aboutOpen,
    setAboutOpen,
    quitConfirmOpen,
    setQuitConfirmOpen,
    shortcutsOpen,
    setShortcutsOpen,
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
