import { createMemo, type Setter } from 'solid-js';
import type { Deliverable, KnowledgeNode, Project, Step } from '@shared/types';
import { applyStatus, applyStepMarker, groupByStatus, nextMarker } from '../panes/projects';
import { buildSlugIndex } from '../wikilinks';
import { categorise } from '@shared/file-category';
import { openDeliverableTarget } from '../deliverable-open';
import type { ModalState } from '../modal-types';
import type { ModalRouter } from '../modal-router';
import type { PromptModalState } from '../prompt-modal';

export interface UseProjectActionsDeps {
  router: ModalRouter;
  projects: () => readonly Project[];
  knowledge: () => KnowledgeNode | null | undefined;
  mutate: (mutator: (items: Project[] | undefined) => Project[]) => void;
  setModal: Setter<ModalState>;
  setPreviewPath: Setter<string | null>;
  setPdfPath: Setter<string | null>;
  setHtmlPath: Setter<string | null>;
  setImagePath: Setter<string | null>;
  setMdxPath: Setter<string | null>;
  openPrompt: (init: Omit<PromptModalState, 'resolve'>) => Promise<string | null>;
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

/** Project-card + preview interactions: open, drop-to-status, step edits,
 *  wikilink resolution. Also owns the derived memos that the projects pane
 *  consumes (status buckets, slug index, active branches). */
export interface UseProjectActions {
  /** Branches referenced by an in-flight conception project — drives the
   *  "project" badge in the Code-pane branch-filter dropdown. */
  activeProjectBranches: () => ReadonlySet<string>;
  /** Stable per-status grouping memo — see groupByStatus. */
  projectsTabGroups: () => ReturnType<typeof groupByStatus>;
  /** Wikilink slug → project/knowledge lookup index. */
  slugIndex: () => ReturnType<typeof buildSlugIndex>;
  /** Resolve the project currently showing in the side preview. */
  previewProject: (previewPath: () => string | null) => Project | null;
  handleOpenProject: (project: Project) => void;
  handleOpenReadmeFromPreview: (project: Project) => void;
  handleOpenDeliverableFromPreview: (deliverable: Deliverable) => void;
  handleOpenFileFromPreview: (path: string, previewPath: () => string | null) => void;
  handleDropOnColumn: (path: string, newStatus: string) => Promise<void>;
  handleToggleStep: (project: Project, step: Step) => Promise<void>;
  handleEditStepText: (project: Project, step: Step, newText: string) => Promise<void>;
  handleAddStep: (project: Project, text: string) => Promise<void>;
  handleWikilink: (slug: string) => void;
  /** Per-card "+ note" — interleaves a prompt with the IPC create + an
   *  immediate open of the new note in the modal editor. */
  handleCreateProjectNote: (project: Project) => Promise<void>;
}

export function useProjectActions(deps: UseProjectActionsDeps): UseProjectActions {
  const slugIndex = createMemo(() =>
    buildSlugIndex((deps.projects() ?? []) as Project[], deps.knowledge() ?? null),
  );

  // Memoise the per-status grouping so a tap that doesn't actually reshuffle
  // statuses (e.g. a step toggle) doesn't rebuild the four-bucket map for
  // every dependent reader. `groupByStatus` itself is pure — referential
  // equality on `projects()` is enough.
  const projectsTabGroups = createMemo(() => groupByStatus((deps.projects() ?? []) as Project[]));

  const activeProjectBranches = createMemo<ReadonlySet<string>>(() => {
    const out = new Set<string>();
    for (const project of deps.projects()) {
      if (project.status !== 'now' && project.status !== 'review') continue;
      if (project.branch) out.add(project.branch);
    }
    return out;
  });

  const previewProject = (previewPath: () => string | null): Project | null => {
    const path = previewPath();
    if (!path) return null;
    return (deps.projects() ?? []).find((p) => p.path === path) ?? null;
  };

  const handleOpenProject = (project: Project): void => {
    // Opening a fresh preview from a card resets any pending back-link from
    // a previously-opened file modal — the user has explicitly chosen a new
    // starting point.
    deps.router.setPreviewBackPath(null);
    deps.setPreviewPath(project.path);
  };

  const handleOpenReadmeFromPreview = (project: Project): void => {
    // Set the back-path so the modal's onClose / "← Back" button returns to
    // the card popup view instead of just dismissing.
    deps.router.setPreviewBackPath(project.path);
    deps.setPreviewPath(null);
    deps.setModal({
      path: project.path,
      title: project.title,
      deliverables: project.deliverables,
      backLabel: project.title,
    });
  };

  const openTarget = (path: string): void =>
    openDeliverableTarget(path, {
      setPdfPath: deps.setPdfPath,
      setHtmlPath: deps.setHtmlPath,
      setImagePath: deps.setImagePath,
      setMdxPath: deps.setMdxPath,
      setModal: deps.setModal,
    });

  const handleOpenDeliverableFromPreview = (deliverable: Deliverable): void => {
    if (deliverable.kind === 'wikilink') {
      handleWikilink(deliverable.path);
      return;
    }
    openTarget(deliverable.path);
  };

  const handleOpenFileFromPreview = (path: string, previewPath: () => string | null): void => {
    const back = previewProject(previewPath)?.title;
    // Markdown opens editable in the note modal (it's usually a project note),
    // closing the preview and remembering it for the back button.
    if (path.toLowerCase().endsWith('.md') || path.toLowerCase().endsWith('.markdown')) {
      deps.router.setPreviewBackPath(previewPath());
      deps.setPreviewPath(null);
      deps.setModal({ path, backLabel: back });
      return;
    }
    // Other in-app viewers (pdf / html / image / text-code) overlay the preview
    // and restore it on close via the back-path; non-viewable kinds open in the
    // OS app and leave the preview in place.
    const base = path.split(/[/\\]/).pop() ?? path;
    const cat = categorise(base);
    if (cat === 'pdf' || cat === 'html' || cat === 'image' || cat === 'text' || cat === 'mdx') {
      deps.router.setPreviewBackPath(previewPath());
    }
    openTarget(path);
  };

  const handleDropOnColumn = async (path: string, newStatus: string): Promise<void> => {
    const items = deps.projects() ?? [];
    const project = items.find((p) => p.path === path);
    if (!project) return;
    if (project.status === newStatus) return;

    const previous = project.status;
    deps.mutate((current) => applyStatus(current ?? [], path, newStatus));
    try {
      const result = await window.condash.setStatus(path, newStatus);
      // Watcher fires a 'project' event for the README that patches the
      // card via `mutateProjects`. No explicit reload — reconcile updates
      // the timeline / closedAt in place.
      if (result.branchWarning) {
        deps.flashToast(result.branchWarning, 'info');
      }
    } catch (err) {
      deps.mutate((current) => applyStatus(current ?? [], path, previous));
      deps.flashToast(`Status change failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleToggleStep = async (project: Project, step: Step): Promise<void> => {
    const next = nextMarker(step.marker);
    deps.mutate((items) => applyStepMarker(items ?? [], project.path, step.lineIndex, next));
    try {
      await window.condash.toggleStep(project.path, step.lineIndex, step.marker, next);
    } catch (err) {
      deps.mutate((items) =>
        applyStepMarker(items ?? [], project.path, step.lineIndex, step.marker),
      );
      deps.flashToast(`Toggle failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleEditStepText = async (
    project: Project,
    step: Step,
    newText: string,
  ): Promise<void> => {
    try {
      await window.condash.editStepText(project.path, step.lineIndex, step.text, newText);
      // Watcher fires a 'change' event for the README; the renderer patches
      // in place. No optimistic update — the line index could shift if
      // anything else changed in the file between read and write.
    } catch (err) {
      deps.flashToast(`Edit step failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleAddStep = async (project: Project, text: string): Promise<void> => {
    try {
      await window.condash.addStep(project.path, text);
    } catch (err) {
      // Surface to the console as well as the toast. Without this, a
      // thrown IPC rejection (missing `## Steps` section, file lock
      // contention) is hard to diagnose from a screenshot — the toast is
      // transient.
      console.error('[addStep]', project.path, err);
      deps.flashToast(`Add step failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleCreateProjectNote = async (project: Project): Promise<void> => {
    const slug = await deps.openPrompt({
      title: `New note for "${project.title}"`,
      message: 'Slug (lowercase, hyphenated). Saved as notes/NN-<slug>.md.',
      placeholder: 'my-new-note',
      confirmLabel: 'Create',
      slugPreview: true,
    });
    if (slug === null) return;
    const trimmed = slug.trim();
    if (!trimmed) {
      deps.flashToast('Empty slug — note not created.', 'error');
      return;
    }
    try {
      const path = await window.condash.createProjectNote(project.path, trimmed);
      const filename = path.split('/').pop() ?? path;
      deps.flashToast(`Created ${filename}.`, 'success');
      // Open the new note in the in-app modal editor straight away.
      deps.setModal({ path, title: filename });
    } catch (err) {
      deps.flashToast(`Could not create note: ${(err as Error).message}`, 'error');
    }
  };

  const handleWikilink = (slug: string): void => {
    const matches = slugIndex().get(slug);
    if (!matches || matches.length === 0) {
      deps.flashToast(`No item matches [[${slug}]]`, 'error');
      return;
    }
    const target = matches[0];
    deps.router.navigateInModal({ path: target.path, title: target.title });
    if (matches.length > 1) {
      deps.flashToast(`[[${slug}]] matched ${matches.length} items — opening the first`, 'info');
    }
  };

  return {
    activeProjectBranches,
    projectsTabGroups,
    slugIndex,
    previewProject,
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
  };
}
