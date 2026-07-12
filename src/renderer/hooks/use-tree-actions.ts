import type { Setter } from 'solid-js';
import type { SkillNode, TreeRoot } from '@shared/types';
import type { TreeAffordance, TreeViewMutationApi, TreeViewPromptApi } from '../panes/tree-view';
import type { ResourcesViewActions } from '../panes/resources';
import type { ModalState } from '../modal-types';
import { openDeliverableTarget } from '../deliverable-open';
import type { createTreeStore } from '../tree-store';
import type { TerminalBridge } from '../terminal-bridge';
import type { PromptModalState } from '../prompt-modal';

export interface UseTreeActionsDeps {
  knowledgeStore: { reload: () => Promise<void> };
  resourcesStore: { reload: () => Promise<void> };
  skillsStore: ReturnType<typeof createTreeStore<SkillNode>>;
  expandTreeDir: (key: TreeRoot, sourceDirRelPath: string) => void;
  openPrompt: (init: Omit<PromptModalState, 'resolve'>) => Promise<string | null>;
  setModal: Setter<ModalState>;
  setPdfPath: Setter<string | null>;
  setHtmlPath: Setter<string | null>;
  setImagePath: Setter<string | null>;
  setMdxPath: Setter<string | null>;
  setSettingsOpen: (open: boolean) => void;
  bridge: TerminalBridge;
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface UseTreeActions {
  treeMutations: TreeViewMutationApi;
  /** Same shape as `treeMutations`, kept as a separate name so the Skills pane
   *  can be wired with read-only affordances independently from Knowledge /
   *  Resources. The Skills pane is read-only post-reframe, so these never
   *  actually run — the affordance list is empty. */
  skillsMutations: TreeViewMutationApi;
  treePrompts: TreeViewPromptApi;
  treeError: (msg: string) => void;
  resourcesActions: ResourcesViewActions;
  /** Per-pane post-mutation handler. Bumps the refresh by reloading the
   *  affected store, expands the source directory so the user sees the
   *  new entry, and (for createMd / importFile) opens the new file the
   *  way that pane normally opens its file kind. `mkdir` only expands so
   *  the user can drop notes in. */
  handleAfterTreeMutation: (
    treeKey: TreeRoot,
    newPath: string,
    kind: TreeAffordance,
    sourceDirRelPath: string,
  ) => void;
  /** Pass the .md's h1 (or fallback) so the modal head doesn't fall back
   *  to displaying the absolute filesystem path — long, low-contrast, and
   *  not what the user wants to read at the top of a note. */
  handleOpenKnowledgeFile: (path: string, title?: string) => void;
  handleViewResource: (path: string, title: string) => void;
  handleOpenSkillFile: (
    path: string,
    title: string,
    shipped?: { diverged: boolean } | null,
  ) => void;
  handleOpenInEditor: (path: string) => void;
  handleOpenDeliverable: (path: string) => void;
}

export function useTreeActions(deps: UseTreeActionsDeps): UseTreeActions {
  const treeMutations: TreeViewMutationApi = {
    createMd: (root, dirRelPath, filename) =>
      window.condash.treeCreateMd(root, dirRelPath, filename),
    mkdir: (root, dirRelPath, name) => window.condash.treeMkdir(root, dirRelPath, name),
    importFile: (root, dirRelPath) => window.condash.treeImportFile(root, dirRelPath),
  };

  // The Skills pane is read-only post-reframe — agedum owns writes, condash
  // surfaces the source-of-truth — so the mutation surface is the same as
  // any other pane but the affordance list on the view is empty. Kept as a
  // distinct name so the wiring stays explicit at the call site.
  const skillsMutations: TreeViewMutationApi = treeMutations;

  const treePrompts: TreeViewPromptApi = {
    prompt: deps.openPrompt,
  };

  const treeError = (msg: string): void => deps.flashToast(msg, 'error');

  const handleOpenInEditor = (path: string): void => {
    void window.condash.openInEditor(path);
  };

  const openTarget = (path: string): void =>
    openDeliverableTarget(path, {
      setPdfPath: deps.setPdfPath,
      setHtmlPath: deps.setHtmlPath,
      setImagePath: deps.setImagePath,
      setMdxPath: deps.setMdxPath,
      setModal: deps.setModal,
    });

  const handleOpenDeliverable = (path: string): void => openTarget(path);

  const handleOpenKnowledgeFile = (path: string, title?: string): void => {
    deps.setModal({ path, title });
  };

  const handleViewResource = (path: string, title: string): void => {
    deps.setModal({ path, title, readOnly: true });
  };

  const handleOpenSkillFile = (
    path: string,
    title: string,
    shipped?: { diverged: boolean } | null,
  ): void => {
    let bannerKind: 'shipped' | 'shipped-diverged' | undefined;
    if (shipped) bannerKind = shipped.diverged ? 'shipped-diverged' : 'shipped';
    // The Skills pane is read-only in both scopes; `readWith: 'skill'` lets the
    // viewer load global-scope files that live outside the conception.
    deps.setModal({ path, title, bannerKind, readOnly: true, readWith: 'skill' });
  };

  const handleAfterTreeMutation = (
    treeKey: TreeRoot,
    newPath: string,
    kind: TreeAffordance,
    sourceDirRelPath: string,
  ): void => {
    // Reload the affected tree explicitly — the chokidar watcher does fire
    // on the new file, but the open-the-newly-created-file branch below
    // runs synchronously and we want the tree pane to reflect the new
    // entry on the same frame.
    if (treeKey === 'knowledge') void deps.knowledgeStore.reload();
    else if (treeKey === 'resources') void deps.resourcesStore.reload();
    else void deps.skillsStore.reload();
    deps.expandTreeDir(treeKey, sourceDirRelPath);
    if (kind === 'mkdir') return;
    if (treeKey === 'knowledge') {
      handleOpenKnowledgeFile(newPath);
      return;
    }
    if (treeKey === 'skills') {
      // Match handleOpenSkillFile — title falls back to the basename
      // because the freshly-created file has no h1 yet.
      const title = newPath.split('/').pop() ?? newPath;
      handleOpenSkillFile(newPath, title, null);
      return;
    }
    // Resources: open the new file the same way a click would — the shared
    // router picks the in-app viewer for markdown / pdf / html / image /
    // text-code and falls back to the OS app for everything else.
    openTarget(newPath);
  };

  const resourcesActions: ResourcesViewActions = {
    openInEditor: handleOpenInEditor,
    viewMarkdown: handleViewResource,
    viewText: handleViewResource,
    viewPdf: (path) => deps.setPdfPath(path),
    viewHtml: (path) => deps.setHtmlPath(path),
    viewImage: (path) => deps.setImagePath(path),
    viewMdx: (path) => deps.setMdxPath(path),
    reveal: (path) => void window.condash.showInFolder(path),
    copyPath: (path) => {
      void navigator.clipboard
        .writeText(path)
        .then(() => deps.flashToast('Path copied', 'success'))
        .catch((err) => deps.flashToast(`Copy failed: ${(err as Error).message}`, 'error'));
    },
    pasteToTerm: async (path) => {
      await deps.bridge.handlePasteToTerm(path);
    },
  };

  return {
    treeMutations,
    skillsMutations,
    treePrompts,
    treeError,
    resourcesActions,
    handleAfterTreeMutation,
    handleOpenKnowledgeFile,
    handleViewResource,
    handleOpenSkillFile,
    handleOpenInEditor,
    handleOpenDeliverable,
  };
}
