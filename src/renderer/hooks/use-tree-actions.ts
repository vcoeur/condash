import type { Setter } from 'solid-js';
import type { SkillNode, SkillTab, TreeRoot } from '@shared/types';
import type { TreeAffordance, TreeViewMutationApi, TreeViewPromptApi } from '../panes/tree-view';
import type { ResourcesViewActions } from '../panes/resources';
import type { ModalState } from '../note-modal';
import type { createTreeStore } from '../tree-store';
import type { TerminalBridge } from '../terminal-bridge';
import type { PromptModalState } from '../prompt-modal';

type SkillsStores = Record<SkillTab, ReturnType<typeof createTreeStore<SkillNode>>>;

export interface UseTreeActionsDeps {
  knowledgeStore: { reload: () => Promise<void> };
  resourcesStore: { reload: () => Promise<void> };
  skillsStores: SkillsStores;
  skillsActiveTab: () => SkillTab;
  expandTreeDir: (key: TreeRoot, sourceDirRelPath: string, skillTab?: SkillTab) => void;
  openPrompt: (init: Omit<PromptModalState, 'resolve'>) => Promise<string | null>;
  setModal: Setter<ModalState>;
  setPdfPath: Setter<string | null>;
  setSettingsOpen: Setter<boolean>;
  bridge: TerminalBridge;
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface UseTreeActions {
  treeMutations: TreeViewMutationApi;
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
    skillTab?: SkillTab,
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

  // Skills mutations pre-bind the currently-active Skills tab so source
  // edits land in `.agents/skills/` and Claude edits in `<skills_path>`.
  // The Kimi tab uses the affordance allowlist to suppress the buttons
  // entirely; the main-process resolver enforces the rule as a backstop.
  const skillsMutations: TreeViewMutationApi = {
    createMd: (root, dirRelPath, filename) =>
      window.condash.treeCreateMd(root, dirRelPath, filename, deps.skillsActiveTab()),
    mkdir: (root, dirRelPath, name) =>
      window.condash.treeMkdir(root, dirRelPath, name, deps.skillsActiveTab()),
    importFile: (root, dirRelPath) =>
      window.condash.treeImportFile(root, dirRelPath, deps.skillsActiveTab()),
  };

  const treePrompts: TreeViewPromptApi = {
    prompt: deps.openPrompt,
  };

  const treeError = (msg: string): void => deps.flashToast(msg, 'error');

  const handleOpenInEditor = (path: string): void => {
    void window.condash.openInEditor(path);
  };

  const handleOpenDeliverable = (path: string): void => {
    if (path.toLowerCase().endsWith('.pdf')) {
      deps.setPdfPath(path);
    } else {
      void window.condash.openInEditor(path);
    }
  };

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
    deps.setModal({ path, title, bannerKind });
  };

  const handleAfterTreeMutation = (
    treeKey: TreeRoot,
    newPath: string,
    kind: TreeAffordance,
    sourceDirRelPath: string,
    skillTab?: SkillTab,
  ): void => {
    // Reload the affected tree explicitly — the chokidar watcher does fire
    // on the new file, but the open-the-newly-created-file branch below
    // runs synchronously and we want the tree pane to reflect the new
    // entry on the same frame.
    if (treeKey === 'knowledge') void deps.knowledgeStore.reload();
    else if (treeKey === 'resources') void deps.resourcesStore.reload();
    else {
      const tab = skillTab ?? deps.skillsActiveTab();
      void deps.skillsStores[tab].reload();
    }
    deps.expandTreeDir(treeKey, sourceDirRelPath, skillTab);
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
    // Resources: open via the user's main editor for non-viewable kinds,
    // or the inline viewer for markdown / pdf / text.
    const lower = newPath.toLowerCase();
    if (lower.endsWith('.md')) {
      handleViewResource(newPath, newPath.split('/').pop() ?? newPath);
    } else if (lower.endsWith('.pdf')) {
      deps.setPdfPath(newPath);
    } else {
      void window.condash.openInEditor(newPath);
    }
  };

  const resourcesActions: ResourcesViewActions = {
    openInEditor: handleOpenInEditor,
    viewMarkdown: handleViewResource,
    viewText: handleViewResource,
    viewPdf: (path) => deps.setPdfPath(path),
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
