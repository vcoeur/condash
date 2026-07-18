// Modal + overlay host. App() composes the workspace and the always-mounted
// terminal pane, then mounts every modal / overlay / toast through this
// component. Extracting the repetitive `<Show when={…}><XModal …/></Show>`
// tail keeps main.tsx focused on the composition root (stores + hooks wiring)
// while this file owns the modal render tree. Every prop is a stable reference
// (signal accessor, setter, handler, or sub-controller object) passed straight
// through from App, so the modals render exactly when and how they did inline.

import { Show } from 'solid-js';
import type { ActionTemplate, Deliverable, Project } from '@shared/types';
import { NoteModal } from './note-modal';
import { ProjectPreview } from './project-preview';
import { PdfModal } from './pdf-modal';
import { HtmlModal } from './html-modal';
import { MdxModal } from './mdx-modal';
import { ImageModal } from './image-modal';
import { HelpModal } from './help-modal';
import { PromptModal } from './prompt-modal';
import { SearchModal } from './search-modal';
import { SettingsModal } from './settings-modal';
import { NewProjectModal } from './new-project-modal';
import { AboutModal } from './about-modal';
import { ConfirmModal } from './confirm-modal';
import { ShortcutsOverlay } from './shortcuts-overlay';
import type { ModalRouter } from './modal-router';
import type { TerminalBridge } from './terminal-bridge';
import type { ProjectsStore } from './projects-store';
import type { UseModals } from './hooks/use-modals';
import type { UseProjectActions } from './hooks/use-project-actions';
import type { UseTreeActions } from './hooks/use-tree-actions';
import type { UseTheme } from './hooks/use-theme';
import type { UseCardMinWidth } from './hooks/use-card-min-width';
import type { UseUiFonts } from './hooks/use-ui-fonts';
import type { UseConception } from './hooks/use-conception';
import type { UseRepoActions } from './hooks/use-repo-actions';
import type { UseToast } from './hooks/use-toast';
import type { UsePromptModal } from './hooks/use-prompt-modal';
import type { UseLayout } from './hooks/use-layout';

/** Props for {@link ModalHost} — the full set of state accessors, setters, and
 *  handlers the modal tree reads, passed through verbatim from App. Field types
 *  reuse the owning hook / store interfaces so the surface stays exact. */
export interface ModalHostProps {
  // --- Project preview (always mounted) + its row callbacks ---
  previewProject: () => Project | null;
  /** Full project list — the preview resolves parent + subprojects from it. */
  projects: () => readonly Project[];
  handleOpenProject: UseProjectActions['handleOpenProject'];
  previewPath: UseModals['previewPath'];
  setPreviewPath: UseModals['setPreviewPath'];
  handleToggleStep: UseProjectActions['handleToggleStep'];
  handleEditStepText: UseProjectActions['handleEditStepText'];
  handleAddStep: UseProjectActions['handleAddStep'];
  handleDropOnColumn: UseProjectActions['handleDropOnColumn'];
  handleOpenReadmeFromPreview: UseProjectActions['handleOpenReadmeFromPreview'];
  handleOpenFileFromPreview: UseProjectActions['handleOpenFileFromPreview'];
  handleOpenDeliverableFromPreview: UseProjectActions['handleOpenDeliverableFromPreview'];
  handleWikilink: UseProjectActions['handleWikilink'];
  handleCreateProjectNote: UseProjectActions['handleCreateProjectNote'];
  handleOpenInEditor: UseTreeActions['handleOpenInEditor'];
  handleOpenKnowledgeFile: UseTreeActions['handleOpenKnowledgeFile'];
  openDeliverable: (deliverable: Deliverable) => void;
  projectActionItems: () => ActionTemplate[];
  bridge: TerminalBridge;
  router: ModalRouter;
  // --- Note modal ---
  modal: UseModals['modal'];
  setModal: UseModals['setModal'];
  setNoteDirty: UseModals['setNoteDirty'];
  isDark: UseTheme['isDark'];
  // --- Help / about / shortcuts ---
  helpDoc: UseModals['helpDoc'];
  setHelpDoc: UseModals['setHelpDoc'];
  aboutOpen: UseModals['aboutOpen'];
  setAboutOpen: UseModals['setAboutOpen'];
  shortcutsOpen: UseModals['shortcutsOpen'];
  setShortcutsOpen: UseModals['setShortcutsOpen'];
  // --- Prompt modal ---
  promptState: UsePromptModal['promptState'];
  setPromptState: UsePromptModal['setPromptState'];
  // --- File viewers ---
  pdfPath: UseModals['pdfPath'];
  setPdfPath: UseModals['setPdfPath'];
  htmlPath: UseModals['htmlPath'];
  setHtmlPath: UseModals['setHtmlPath'];
  imagePath: UseModals['imagePath'];
  setImagePath: UseModals['setImagePath'];
  mdxPath: UseModals['mdxPath'];
  setMdxPath: UseModals['setMdxPath'];
  // --- Search modal ---
  searchModalOpen: UseModals['searchModalOpen'];
  setSearchModalOpen: UseModals['setSearchModalOpen'];
  setLogsOpenRequest: UseModals['setLogsOpenRequest'];
  nextLogsOpenNonce: UseModals['nextLogsOpenNonce'];
  selectWorking: UseLayout['selectWorking'];
  // --- Settings modal ---
  settingsOpen: UseModals['settingsOpen'];
  setSettingsOpen: UseModals['setSettingsOpen'];
  conceptionPath: () => string | null;
  theme: UseTheme['theme'];
  handleThemeChange: UseTheme['handleThemeChange'];
  previewTheme: UseTheme['previewTheme'];
  cardMinWidth: UseCardMinWidth['cardMinWidth'];
  handleCardMinWidthChange: UseCardMinWidth['handleCardMinWidthChange'];
  uiFonts: UseUiFonts['uiFonts'];
  handleUiFontsChange: UseUiFonts['handleUiFontsChange'];
  // --- New project modal ---
  newProjectOpen: UseModals['newProjectOpen'];
  setNewProjectOpen: UseModals['setNewProjectOpen'];
  reloadProjects: ProjectsStore['reload'];
  flashToast: UseToast['flashToast'];
  // --- Quit confirm ---
  quitConfirmOpen: UseModals['quitConfirmOpen'];
  setQuitConfirmOpen: UseModals['setQuitConfirmOpen'];
  noteDirty: UseModals['noteDirty'];
  handleConfirmQuit: UseConception['handleConfirmQuit'];
  // --- Force-stop confirm ---
  forceStopState: UseModals['forceStopState'];
  setForceStopState: UseModals['setForceStopState'];
  runForceStop: UseRepoActions['runForceStop'];
  // --- Init confirm ---
  initConfirmState: UseModals['initConfirmState'];
  setInitConfirmState: UseModals['setInitConfirmState'];
  runInit: UseConception['runInit'];
  // --- Toast ---
  toast: UseToast['toast'];
}

/** Render every modal / overlay / toast App composes. Each block is mounted
 *  on its own `Show` (or always-on for the preview / prompt) exactly as it was
 *  inline in App. */
export function ModalHost(props: ModalHostProps) {
  const {
    previewProject,
    projects,
    handleOpenProject,
    previewPath,
    setPreviewPath,
    handleToggleStep,
    handleEditStepText,
    handleAddStep,
    handleDropOnColumn,
    handleOpenReadmeFromPreview,
    handleOpenFileFromPreview,
    handleOpenDeliverableFromPreview,
    handleWikilink,
    handleCreateProjectNote,
    handleOpenInEditor,
    handleOpenKnowledgeFile,
    openDeliverable,
    projectActionItems,
    bridge,
    router,
    modal,
    setModal,
    setNoteDirty,
    isDark,
    helpDoc,
    setHelpDoc,
    aboutOpen,
    setAboutOpen,
    shortcutsOpen,
    setShortcutsOpen,
    promptState,
    setPromptState,
    pdfPath,
    setPdfPath,
    htmlPath,
    setHtmlPath,
    imagePath,
    setImagePath,
    mdxPath,
    setMdxPath,
    searchModalOpen,
    setSearchModalOpen,
    setLogsOpenRequest,
    nextLogsOpenNonce,
    selectWorking,
    settingsOpen,
    setSettingsOpen,
    conceptionPath,
    theme,
    handleThemeChange,
    previewTheme,
    cardMinWidth,
    handleCardMinWidthChange,
    uiFonts,
    handleUiFontsChange,
    newProjectOpen,
    setNewProjectOpen,
    reloadProjects,
    flashToast,
    quitConfirmOpen,
    setQuitConfirmOpen,
    noteDirty,
    handleConfirmQuit,
    forceStopState,
    setForceStopState,
    runForceStop,
    initConfirmState,
    setInitConfirmState,
    runInit,
    toast,
  } = props;

  return (
    <>
      <ProjectPreview
        project={previewProject()}
        allProjects={projects}
        onOpenProject={handleOpenProject}
        onClose={() => setPreviewPath(null)}
        onToggleStep={handleToggleStep}
        onEditStepText={handleEditStepText}
        onAddStep={handleAddStep}
        onChangeStatus={(p, s) => void handleDropOnColumn(p.path, s)}
        onOpenReadme={handleOpenReadmeFromPreview}
        onOpenFile={(path) => handleOpenFileFromPreview(path, previewPath)}
        onOpenInEditor={handleOpenInEditor}
        onOpenDeliverable={handleOpenDeliverableFromPreview}
        onWorkOn={(p) => void bridge.handleWorkOn(p)}
        projectActions={projectActionItems()}
        onProjectAction={(p, a) => void bridge.handleProjectAction(p, a)}
        onCreateNote={(p) => void handleCreateProjectNote(p)}
      />

      <Show when={modal()}>
        <NoteModal
          state={modal()}
          onClose={() => router.closeChildModal(() => setModal(null))}
          onOpenInEditor={handleOpenInEditor}
          onOpenDeliverable={openDeliverable}
          onWikilink={handleWikilink}
          onOpenMarkdown={(path) => router.navigateInModal({ path })}
          onBack={router.handleModalBack}
          onOpenPdf={(path) => setPdfPath(path)}
          onOpenMdx={(path) => setMdxPath(path)}
          onOpenHelp={(doc) => setHelpDoc(doc)}
          onDirtyChange={setNoteDirty}
          dark={isDark()}
        />
      </Show>

      <Show when={helpDoc()}>
        <HelpModal doc={helpDoc()!} onClose={() => setHelpDoc(null)} />
      </Show>

      <Show when={aboutOpen()}>
        <AboutModal onClose={() => setAboutOpen(false)} />
      </Show>

      <Show when={shortcutsOpen()}>
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      </Show>

      <PromptModal state={promptState()} onClose={() => setPromptState(null)} />

      <Show when={pdfPath()}>
        <PdfModal
          path={pdfPath()!}
          onClose={() => router.closeChildModal(() => setPdfPath(null))}
          onOpenInOs={handleOpenInEditor}
          onReveal={(p) => void window.condash.showInFolder(p)}
        />
      </Show>

      <Show when={htmlPath()}>
        <HtmlModal
          path={htmlPath()!}
          onClose={() => router.closeChildModal(() => setHtmlPath(null))}
          onOpenInOs={handleOpenInEditor}
          onReveal={(p) => void window.condash.showInFolder(p)}
        />
      </Show>

      <Show when={imagePath()}>
        <ImageModal
          path={imagePath()!}
          onClose={() => router.closeChildModal(() => setImagePath(null))}
          onOpenInOs={handleOpenInEditor}
          onReveal={(p) => void window.condash.showInFolder(p)}
        />
      </Show>

      <Show when={mdxPath()}>
        <MdxModal
          path={mdxPath()!}
          onClose={() => router.closeChildModal(() => setMdxPath(null))}
          onOpenInEditor={handleOpenInEditor}
          onReveal={(p) => void window.condash.showInFolder(p)}
          onWikilink={handleWikilink}
          onOpenMarkdown={(path) => setModal({ path, readOnly: true })}
          onOpenPdf={(path) => setPdfPath(path)}
          onOpenMdx={(path) => setMdxPath(path)}
        />
      </Show>

      <Show when={searchModalOpen()}>
        <SearchModal
          onClose={() => setSearchModalOpen(false)}
          onOpenProject={(projectDir) => {
            // ProjectPreview is keyed on the README path (matching
            // Project.path), but search returns the project directory —
            // map back to the README so the preview lookup hits.
            router.setPreviewBackPath(null);
            setPreviewPath(`${projectDir}/README.md`);
          }}
          onOpenFile={(path, projectPath, projectTitle) => {
            if (projectPath && projectTitle) {
              // Project note opened from search: close any open preview and
              // remember the project README so the note modal's back button
              // returns to the project preview instead of dismissing.
              router.setPreviewBackPath(`${projectPath}/README.md`);
              setPreviewPath(null);
              setModal({ path, backLabel: projectTitle });
              return;
            }
            handleOpenKnowledgeFile(path);
          }}
          onOpenLog={(path) => {
            // Open the Logs pane and post an open-request the pane reacts
            // to. Nonce bumps every time so reactivating the same path
            // still fires the createEffect.
            setLogsOpenRequest({ path, nonce: nextLogsOpenNonce() });
            selectWorking('logs');
          }}
        />
      </Show>

      <Show when={settingsOpen() && conceptionPath()}>
        <SettingsModal
          conceptionPath={conceptionPath()!}
          theme={theme()}
          onChangeTheme={handleThemeChange}
          onPreviewTheme={previewTheme}
          cardMinWidth={cardMinWidth()}
          onChangeCardMinWidth={handleCardMinWidthChange}
          uiFonts={uiFonts()}
          onChangeUiFonts={handleUiFontsChange}
          onClose={() => setSettingsOpen(false)}
        />
      </Show>

      <Show when={newProjectOpen()}>
        <NewProjectModal
          onClose={() => setNewProjectOpen(false)}
          onCreated={(result) => {
            setNewProjectOpen(false);
            // Refresh the project list and prime the popup. The popup
            // resolves the Project object via `previewProject()`, which
            // re-reads `projects()`, so the popup mounts as soon as
            // reload settles.
            void reloadProjects();
            setPreviewPath(result.readme);
            flashToast(`Created ${result.relPath}`, 'success');
          }}
        />
      </Show>

      <Show when={quitConfirmOpen()}>
        <ConfirmModal
          title="Quit Condash?"
          body={() => (
            <>
              <p class="confirm-message">Any running terminal sessions will be terminated.</p>
              <Show when={noteDirty()}>
                <p class="confirm-warn">Unsaved note edits will also be lost.</p>
              </Show>
            </>
          )}
          confirmLabel="Quit"
          cancelLabel="Cancel"
          destructive
          onCancel={() => setQuitConfirmOpen(false)}
          onConfirm={() => {
            setQuitConfirmOpen(false);
            handleConfirmQuit();
          }}
        />
      </Show>

      <Show when={forceStopState()}>
        {(repo) => (
          <ConfirmModal
            title={`Force-stop ${repo().name}?`}
            body="The repo's run command will be killed via the configured force_stop. Use only when the dev server is unresponsive."
            confirmLabel="Force-stop"
            destructive
            onCancel={() => setForceStopState(null)}
            onConfirm={() => {
              const r = repo();
              setForceStopState(null);
              void runForceStop(r);
            }}
          />
        )}
      </Show>

      <Show when={initConfirmState()}>
        {(state) => (
          <ConfirmModal
            title="Initialise from template?"
            body={
              `This folder is missing ${state().missing.join(' and ')}.\n\n` +
              'Initialise it from the bundled conception template? ' +
              'Skill files, seed indexes, and example config will be laid down. ' +
              'Existing files are left alone.'
            }
            confirmLabel="Initialise"
            onCancel={() => setInitConfirmState(null)}
            onConfirm={() => {
              const path = state().path;
              setInitConfirmState(null);
              void runInit(path);
            }}
          />
        )}
      </Show>

      <Show when={toast()}>
        {(t) => (
          <div
            class="toast"
            data-kind={t().kind}
            role={t().kind === 'error' ? 'alert' : 'status'}
            aria-live={t().kind === 'error' ? 'assertive' : 'polite'}
          >
            {t().msg}
          </div>
        )}
      </Show>
    </>
  );
}
