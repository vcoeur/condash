import { render } from 'solid-js/web';
import { createSignal, For, Show } from 'solid-js';
import type { KnowledgeNode, ResourceNode, SkillNode, SkillTab } from '@shared/types';
import { NoteModal } from './note-modal';
import { ProjectPreview } from './project-preview';
import { TerminalPane, type TerminalPaneHandle } from './terminal-pane';
import { PdfModal } from './pdf-modal';
import { HelpModal } from './help-modal';
import { WelcomeScreen } from './welcome-screen';
import { PromptModal } from './prompt-modal';
import { ProjectsView } from './panes/projects';
import { KnowledgeView } from './panes/knowledge';
import { CodeView } from './panes/code';
import { ResourcesView } from './panes/resources';
import { SkillsView } from './panes/skills';
import { LogsView } from './panes/logs';
import { SearchModal } from './search-modal';
import { SettingsModal } from './settings-modal';
import { usableActionTemplates } from './settings-modal-parts/data';
import { NewProjectModal } from './new-project-modal';
import { createModalRouter } from './modal-router';
import { createTerminalBridge } from './terminal-bridge';
import { createTreeExpansion } from './tree-expansion';
import { createBranchFilterStore } from './branch-filter-store';
import { createReposStore } from './repos-store';
import { createSessionsStore } from './sessions-store';
import { createProjectsStore } from './projects-store';
import { createTreeStore } from './tree-store';
import { createGlobalKeyboard } from './global-keyboard';
import { createMenuRouter } from './menu-commands';
import { QuitConfirmModal } from './quit-confirm-modal';
import { AboutModal } from './about-modal';
import { ConfirmModal } from './confirm-modal';
import { ShortcutsOverlay } from './shortcuts-overlay';
import { useToast } from './hooks/use-toast';
import { usePromptModal } from './hooks/use-prompt-modal';
import { useTheme } from './hooks/use-theme';
import { useCardMinWidth } from './hooks/use-card-min-width';
import { useLayout } from './hooks/use-layout';
import { useConfigBindings } from './hooks/use-config-bindings';
import { useModals } from './hooks/use-modals';
import { useProjectActions } from './hooks/use-project-actions';
import { useTreeActions } from './hooks/use-tree-actions';
import { useRepoActions } from './hooks/use-repo-actions';
import { useConception } from './hooks/use-conception';
import { useWelcome } from './hooks/use-welcome';
import { useSkillsTab } from './hooks/use-skills-tab';
import { useTreeEvents } from './hooks/use-tree-events';
import type { Project, WorkingSurface } from '@shared/types';
import './styles.css';
import './modal-base.css';
import './project-preview.css';
import './action-split-button.css';
import './welcome-screen.css';

/** Right-strip handles in display order. Each entry binds the
 *  working-surface enum value to its label + keyboard shortcut so the
 *  edge-strip JSX can map over them instead of repeating one block per
 *  surface. The actual key bindings live in `global-keyboard.ts`; the
 *  string here is just the tooltip suffix. */
const WORKING_SURFACE_HANDLES: ReadonlyArray<{
  key: NonNullable<WorkingSurface>;
  label: string;
  shortcut: string;
}> = [
  { key: 'code', label: 'Code', shortcut: 'Ctrl+Shift+C' },
  { key: 'knowledge', label: 'Knowledge', shortcut: 'Ctrl+Shift+K' },
  { key: 'resources', label: 'Resources', shortcut: 'Ctrl+R' },
  { key: 'skills', label: 'Skills', shortcut: 'Ctrl+L' },
  { key: 'logs', label: 'Logs', shortcut: 'Ctrl+Shift+L' },
];

function App() {
  // --- Toast first so every downstream hydration call can surface a
  //     failure to the user as soon as the IPC resolves ---
  const { toast, flashToast } = useToast();

  // --- Conception path (early so downstream stores can pick it up as a
  //     dep without circular hand-shakes) ---
  const [conceptionPath, setConceptionPath] = createSignal<string | null>(null);
  void window.condash
    .getConceptionPath()
    .then(setConceptionPath)
    .catch((err) =>
      flashToast(`Could not load conception path: ${(err as Error).message}`, 'error'),
    );

  // --- Self-contained hooks (no cross-deps) -----------------------------
  const { promptState, setPromptState, openPrompt } = usePromptModal();
  const { theme, isDark, handleThemeChange } = useTheme({ flashToast });
  const { cardMinWidth, handleCardMinWidthChange } = useCardMinWidth();
  const {
    modal,
    setModal,
    previewPath,
    setPreviewPath,
    pdfPath,
    setPdfPath,
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
  } = useModals();

  // --- Layout (toggle helpers + splitter drag) --------------------------
  const {
    layout,
    updateLayout,
    toggleProjects,
    toggleTerminal,
    selectWorking,
    ensureTerminalOpen,
    topBandVisible,
    topBandStyle,
    startSplitterDrag,
  } = useLayout({ flashToast });

  // --- Tree expansion + branch filter (existing stores) ------------------
  const treeExpansion = createTreeExpansion({ flashToast });
  const {
    knowledgeExpanded,
    resourcesExpanded,
    skillsExpandedByTab,
    toggleTreeExpand,
    expandTreeDir,
  } = treeExpansion;
  const branchFilter = createBranchFilterStore({ flashToast });

  // --- Sessions store (drives Code-pane live badges + Stop button) ------
  const { allSessions, liveRepos, liveSessionCwds, codeRunSessions } = createSessionsStore();

  // --- Domain stores ----------------------------------------------------
  const projectsStore = createProjectsStore({ conceptionPath });
  const { projects, loaded: projectsLoaded, mutate, reload: reloadProjects } = projectsStore;

  const knowledgeStore = createTreeStore<KnowledgeNode>({
    conceptionPath,
    fetcher: () => window.condash.readKnowledgeTree(),
    key: 'relPath',
  });
  const knowledge = knowledgeStore.root;

  const resourcesStore = createTreeStore<ResourceNode>({
    conceptionPath,
    fetcher: () => window.condash.readResourcesTree(),
    key: 'relPath',
  });
  const resources = resourcesStore.root;

  // One tree store per Skills tab. The trees back independent on-disk
  // roots (`.agents/skills/`, `<skills_path>`, `.kimi/skills/`), so each
  // gets its own fetcher, store, and reload trigger. All three are eagerly
  // loaded when the conception path is set so tab switching is paint-only.
  const skillsStores: Record<SkillTab, ReturnType<typeof createTreeStore<SkillNode>>> = {
    generic: createTreeStore<SkillNode>({
      conceptionPath,
      fetcher: () => window.condash.readSkillsTree('generic'),
      key: 'relPath',
    }),
    claude: createTreeStore<SkillNode>({
      conceptionPath,
      fetcher: () => window.condash.readSkillsTree('claude'),
      key: 'relPath',
    }),
    kimi: createTreeStore<SkillNode>({
      conceptionPath,
      fetcher: () => window.condash.readSkillsTree('kimi'),
      key: 'relPath',
    }),
  };
  const { skillsActiveTab, handleSkillsTabSelect, activeSkillsRoot } = useSkillsTab({
    skillsStores,
    flashToast,
  });

  const reposStore = createReposStore({ conceptionPath, flashToast });
  const { repos, reposLoaded, reloadRepos } = reposStore;

  // --- Config bindings (Open With + terminal prefs) ---------------------
  const { openWithSlots, terminalPrefs, reloadConfig } = useConfigBindings({ conceptionPath });

  // --- Modal router + terminal bridge -----------------------------------
  let terminalHandle: TerminalPaneHandle | null = null;
  const router = createModalRouter({ modal, setModal, setPdfPath, setPreviewPath });
  const bridge = createTerminalBridge({
    terminalHandle: () => terminalHandle,
    ensureTerminalOpen,
    terminalPrefs,
    flashToast,
    conceptionPath,
  });

  // --- Repo actions (Code-pane row callbacks) ---------------------------
  const { handleLaunch, handleForceStop, runForceStop, handleStopRepo, handleRunRepo } =
    useRepoActions({
      allSessions,
      getTerminalHandle: () => terminalHandle,
      setForceStopState,
      flashToast,
    });

  // --- Tree actions (createMd / mkdir / importFile + open handlers) -----
  const {
    treeMutations,
    skillsMutations,
    treePrompts,
    treeError,
    resourcesActions,
    handleAfterTreeMutation,
    handleOpenKnowledgeFile,
    handleOpenSkillFile,
    handleOpenInEditor,
    handleOpenDeliverable,
  } = useTreeActions({
    knowledgeStore,
    resourcesStore,
    skillsStores,
    skillsActiveTab,
    expandTreeDir,
    openPrompt,
    setModal,
    setPdfPath,
    setSettingsOpen,
    bridge,
    flashToast,
  });

  // --- Tree-events handler (wires watcher pushes to store reloads) ------
  useTreeEvents({
    mutateProjects: mutate,
    reloadProjects,
    knowledgeStore,
    resourcesStore,
    skillsStores,
    reloadConfig,
    reloadRepos,
  });

  // --- Project actions (card open, drop-to-status, step edits, links) ---
  const projectActions = useProjectActions({
    router,
    projects,
    knowledge,
    mutate,
    setModal,
    setPreviewPath,
    setPdfPath,
    openPrompt,
    flashToast,
  });
  const {
    activeProjectBranches,
    projectsTabGroups,
    handleOpenProject,
    handleOpenReadmeFromPreview,
    handleOpenDeliverableFromPreview,
    handleOpenFileFromPreview,
    handleDropOnColumn,
    handleToggleStep,
    handleEditStepText,
    handleAddStep,
    handleWikilink,
    handleCreateProjectNote,
  } = projectActions;
  const previewProject = (): Project | null => projectActions.previewProject(previewPath);

  // --- Welcome screen ---------------------------------------------------
  const knowledgeIsEmpty = (): boolean => {
    const k = knowledge();
    if (k === null || k === undefined) return true;
    if (Array.isArray((k as { children?: unknown[] }).children)) {
      return (k as { children: unknown[] }).children.length === 0;
    }
    return false;
  };
  const {
    shouldShowWelcome,
    handleWelcomeOpenTree,
    handleWelcomeTakeTour,
    handleWelcomeOpenDocs,
    handleWelcomeDismiss,
  } = useWelcome({
    conceptionPath,
    projectsLoaded,
    projects,
    knowledgeIsEmpty,
    setHelpDoc,
  });

  // --- Conception lifecycle (pick / refresh / init / quit) --------------
  const { handleRefresh, handlePick, runInit, handleConfirmQuit } = useConception({
    conceptionPath,
    setConceptionPath,
    knowledgeStore,
    resourcesStore,
    skillsStores,
    reloadProjects,
    reloadConfig,
    reloadRepos,
    setInitConfirmState,
    flashToast,
  });

  // --- Global wiring (keyboard shortcuts + native menu router) ----------
  createGlobalKeyboard({
    layout,
    terminalPrefs,
    getTerminalHandle: () => terminalHandle,
    toggleTerminal,
    bridge,
    setSearchModalOpen,
    setShortcutsOpen,
  });
  createMenuRouter({
    conceptionPath,
    layout,
    setConceptionPath,
    setSearchModalOpen,
    setSettingsOpen,
    setNewProjectOpen,
    setQuitConfirmOpen,
    setAboutOpen,
    setHelpDoc,
    toggleProjects,
    toggleTerminal,
    selectWorking,
    handleRefresh: () => handleRefresh(),
    handlePick: () => handlePick(),
    flashToast,
  });

  // --- Top-band ref for the splitter drag (must live on App so the
  //     callback ref captures the DOM node into a closure that the hook
  //     can read) ---
  let topBandRef: HTMLDivElement | undefined;
  const handlesEnabled = (): boolean => !!conceptionPath();

  return (
    <div class="app">
      <div class="workspace">
        {/* Left strip — Projects handle. Always visible so a hidden
            pane can be summoned back. Disabled until a conception path
            is picked, since there is no Projects content to show. */}
        <aside class="edge-strip edge-strip-left">
          <button
            class="edge-handle edge-handle-vertical"
            classList={{ active: layout().projects }}
            aria-pressed={layout().projects}
            onClick={toggleProjects}
            disabled={!handlesEnabled()}
            title={layout().projects ? 'Hide Projects' : 'Show Projects'}
          >
            <span class="edge-handle-label">Projects</span>
          </button>
        </aside>

        <div class="workspace-center">
          <Show
            when={conceptionPath()}
            fallback={
              <div class="empty">
                <p>Pick a conception directory to list its projects.</p>
                <button onClick={handlePick}>Choose folder…</button>
              </div>
            }
          >
            <Show when={shouldShowWelcome()}>
              <WelcomeScreen
                conceptionPath={conceptionPath()!}
                onCreateProject={() => setNewProjectOpen(true)}
                onOpenTree={handleWelcomeOpenTree}
                onTakeTour={handleWelcomeTakeTour}
                onOpenDocs={handleWelcomeOpenDocs}
                onOpenSettings={() => setSettingsOpen(true)}
                onDismiss={handleWelcomeDismiss}
              />
            </Show>
            <Show when={!shouldShowWelcome() && !topBandVisible() && !layout().terminal}>
              <div class="all-panes-hidden-helper">
                <h2>All panes are hidden</h2>
                <p>Bring one back to start working:</p>
                <div class="all-panes-hidden-actions">
                  <button onClick={toggleProjects}>Show Projects</button>
                  <button onClick={() => selectWorking('code')}>Show Code</button>
                  <button onClick={() => selectWorking('knowledge')}>Show Knowledge</button>
                  <button onClick={() => selectWorking('resources')}>Show Resources</button>
                  <button onClick={() => selectWorking('skills')}>Show Skills</button>
                  <button onClick={toggleTerminal}>Show Terminal</button>
                </div>
              </div>
            </Show>
            <Show when={topBandVisible()}>
              <div class="top-band" ref={(el) => (topBandRef = el)} style={topBandStyle()}>
                <Show when={layout().projects}>
                  <section class="pane pane-projects">
                    <Show
                      when={(projects() ?? []).length > 0}
                      fallback={<div class="empty">No projects found under projects/.</div>}
                    >
                      <ProjectsView
                        buckets={projectsTabGroups()}
                        onOpen={handleOpenProject}
                        onToggleStep={handleToggleStep}
                        onDropProject={handleDropOnColumn}
                        onWorkOn={(p) => void bridge.handleWorkOn(p)}
                        projectActions={usableActionTemplates(
                          terminalPrefs()?.projectActions ?? [],
                        )}
                        onProjectAction={(p, a) => void bridge.handleProjectAction(p, a)}
                        onNewProject={() => setNewProjectOpen(true)}
                        newProjectActions={usableActionTemplates(
                          terminalPrefs()?.newProjectActions ?? [],
                        )}
                        onNewProjectAction={(a) => void bridge.handleNewProjectAction(a)}
                      />
                    </Show>
                  </section>
                </Show>

                <Show when={layout().projects && layout().working !== null}>
                  <div
                    class="top-band-splitter"
                    onMouseDown={(e) => startSplitterDrag(e, topBandRef)}
                    title="Drag to resize"
                  />
                </Show>

                <Show when={layout().working === 'knowledge'}>
                  <section class="pane pane-working">
                    <Show
                      when={knowledge()}
                      fallback={
                        <div class="empty">
                          No knowledge/ directory under the selected conception path.
                        </div>
                      }
                    >
                      <KnowledgeView
                        root={knowledge()!}
                        onOpen={handleOpenKnowledgeFile}
                        expanded={knowledgeExpanded}
                        onToggleExpand={(rel) => toggleTreeExpand('knowledge', rel)}
                        mutations={treeMutations}
                        prompts={treePrompts}
                        onAfterMutation={(newPath, kind, source) =>
                          handleAfterTreeMutation('knowledge', newPath, kind, source)
                        }
                        onError={treeError}
                      />
                    </Show>
                  </section>
                </Show>

                <Show when={layout().working === 'resources'}>
                  <section class="pane pane-working">
                    <ResourcesView
                      root={resources() ?? null}
                      actions={resourcesActions}
                      onOpenSettings={() => setSettingsOpen(true)}
                      onOpenConceptionDir={() => {
                        void window.condash.openConceptionDirectory().catch((err) => {
                          flashToast(`Open failed: ${(err as Error).message}`, 'error');
                        });
                      }}
                      expanded={resourcesExpanded}
                      onToggleExpand={(rel) => toggleTreeExpand('resources', rel)}
                      mutations={treeMutations}
                      prompts={treePrompts}
                      onAfterMutation={(newPath, kind, source) =>
                        handleAfterTreeMutation('resources', newPath, kind, source)
                      }
                      onError={treeError}
                    />
                  </section>
                </Show>

                <Show when={layout().working === 'logs'}>
                  <section class="pane pane-working">
                    <LogsView openRequest={logsOpenRequest} />
                  </section>
                </Show>

                <Show when={layout().working === 'skills'}>
                  <section class="pane pane-working">
                    <SkillsView
                      tab={skillsActiveTab()}
                      onSelectTab={handleSkillsTabSelect}
                      root={activeSkillsRoot() ?? null}
                      onOpen={handleOpenSkillFile}
                      onOpenSettings={() => setSettingsOpen(true)}
                      onCopyInstallCommand={() => {
                        void navigator.clipboard
                          .writeText('condash skills install')
                          .then(() => flashToast('Copied install command', 'success'))
                          .catch((err) =>
                            flashToast(`Copy failed: ${(err as Error).message}`, 'error'),
                          );
                      }}
                      expanded={() => skillsExpandedByTab(skillsActiveTab())()}
                      onToggleExpand={(rel) => toggleTreeExpand('skills', rel, skillsActiveTab())}
                      mutations={skillsMutations}
                      prompts={treePrompts}
                      onAfterMutation={(newPath, kind, source) =>
                        handleAfterTreeMutation('skills', newPath, kind, source, skillsActiveTab())
                      }
                      onError={treeError}
                    />
                  </section>
                </Show>

                <Show when={layout().working === 'code'}>
                  <section class="pane pane-working">
                    <Show
                      when={repos.length > 0}
                      fallback={
                        <Show when={reposLoaded()} fallback={<div class="empty">Loading…</div>}>
                          <div class="empty">
                            <p>No repositories configured.</p>
                            <p>
                              Add entries to <code>repositories</code> in <code>condash.json</code>.
                            </p>
                            <button
                              type="button"
                              class="empty-cta"
                              onClick={() => setSettingsOpen(true)}
                            >
                              + Add repository
                            </button>
                          </div>
                        </Show>
                      }
                    >
                      <CodeView
                        repos={repos}
                        slots={openWithSlots() ?? {}}
                        liveRepos={liveRepos()}
                        liveSessionCwds={liveSessionCwds()}
                        codeRunSessions={codeRunSessions()}
                        xtermPrefs={terminalPrefs()?.xterm}
                        selectedBranches={branchFilter.selectedBranches()}
                        activeProjectBranches={activeProjectBranches()}
                        stickyAllBranches={branchFilter.stickyAll()}
                        onToggleBranch={branchFilter.toggleBranch}
                        onSetAllSticky={branchFilter.setAllSticky}
                        onSetNoneBranches={branchFilter.setNone}
                        onOpen={handleOpenInEditor}
                        onLaunch={(slot, path) => void handleLaunch(slot, path)}
                        onForceStop={(r) => void handleForceStop(r)}
                        onStop={handleStopRepo}
                        onRun={(r, wt) => void handleRunRepo(r, wt)}
                        onOpenInTerm={(r, wt) => void bridge.handleOpenInTerm(r, wt)}
                        onCloseSession={(id) => void window.condash.termClose(id)}
                      />
                    </Show>
                  </section>
                </Show>
              </div>
            </Show>
          </Show>
        </div>

        {/* Right strip — working-surface handles. Mutually exclusive in
            the working slot; clicking the active one hides the slot,
            clicking another swaps. Surfaces listed in display order. */}
        <aside class="edge-strip edge-strip-right">
          <For each={WORKING_SURFACE_HANDLES}>
            {(handle) => (
              <button
                class="edge-handle edge-handle-vertical"
                classList={{ active: layout().working === handle.key }}
                aria-pressed={layout().working === handle.key}
                onClick={() => selectWorking(layout().working === handle.key ? null : handle.key)}
                disabled={!handlesEnabled()}
                title={
                  layout().working === handle.key
                    ? `Hide ${handle.label} (${handle.shortcut})`
                    : `Show ${handle.label} (${handle.shortcut})`
                }
              >
                <span class="edge-handle-label">{handle.label}</span>
              </button>
            )}
          </For>
        </aside>
      </div>

      {/* TerminalPane is always mounted at full window width, below the
          workspace row. Its own tab strip carries the persistent
          Terminal handle on the left — clicking the handle toggles
          the body open/closed. When closed, only the strip remains
          visible (height collapses to the strip height); when open,
          the body grows to its persisted height above the strip. The
          left / right edge strips above end where this pane begins,
          so the bottom band is genuinely full width. */}
      <TerminalPane
        open={layout().terminal}
        onClose={() => updateLayout({ terminal: false })}
        onTogglePane={toggleTerminal}
        launchers={terminalPrefs()?.launchers ?? []}
        cwd={conceptionPath()}
        xtermPrefs={terminalPrefs()?.xterm}
        registerHandle={(handle) => {
          terminalHandle = handle;
        }}
      />

      <ProjectPreview
        project={previewProject()}
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
        projectActions={usableActionTemplates(terminalPrefs()?.projectActions ?? [])}
        onProjectAction={(p, a) => void bridge.handleProjectAction(p, a)}
        onCreateNote={(p) => void handleCreateProjectNote(p)}
      />

      <Show when={modal()}>
        <NoteModal
          state={modal()}
          onClose={() => router.closeChildModal(() => setModal(null))}
          onOpenInEditor={handleOpenInEditor}
          onOpenDeliverable={handleOpenDeliverable}
          onWikilink={handleWikilink}
          onOpenMarkdown={(path) => router.navigateInModal({ path })}
          onBack={router.handleModalBack}
          onOpenPdf={(path) => setPdfPath(path)}
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
          onOpenFile={handleOpenKnowledgeFile}
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
          cardMinWidth={cardMinWidth()}
          onChangeCardMinWidth={handleCardMinWidthChange}
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
        <QuitConfirmModal
          onCancel={() => setQuitConfirmOpen(false)}
          onConfirm={() => {
            setQuitConfirmOpen(false);
            handleConfirmQuit();
          }}
          noteDirty={noteDirty()}
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
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
render(() => <App />, root);
