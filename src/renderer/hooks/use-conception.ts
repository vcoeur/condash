import type { SkillNode } from '@shared/types';
import type { createTreeStore } from '../tree-store';

export interface UseConceptionDeps {
  conceptionPath: () => string | null;
  setConceptionPath: (next: string | null) => void;
  knowledgeStore: { reload: () => Promise<void> };
  resourcesStore: { reload: () => Promise<void> };
  skillsStore: ReturnType<typeof createTreeStore<SkillNode>>;
  reloadProjects: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  reloadRepos: () => Promise<void>;
  /** Refetch the Agents pane's createResource. Fire-and-forget. */
  reloadAgents: () => void;
  /** Refetch the Tasks pane's createResource. Fire-and-forget. */
  reloadTasks: () => void;
  /** Bump the Logs pane's external refresh trigger (the pane owns its own
   *  createResource, so refresh is push-via-signal rather than a reload fn). */
  reloadLogs: () => void;
  setInitConfirmState: (next: { path: string; missing: string[] } | null) => void;
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface UseConception {
  /** Full fan-out reload. Used by View → Refresh and as the success tail
   *  of initConception. Covers every working surface: projects, code,
   *  knowledge, resources, skills, agents, tasks, and logs. Deliverables
   *  are derived from the projects list, so reloadProjects refreshes them
   *  too. Each store applies `reconcile` on swap-in so card / row DOM
   *  identity survives — the visible effect is content updating in place,
   *  not the pane blanking and rebuilding. */
  reloadAll: () => Promise<void>;
  /** F5 / View → Refresh: drop the per-worktree git-status cache so
   *  dirty/upstream recompute on the next listRepos, then fan out a full
   *  reload across every store. Repos are explicit because the
   *  reposStore's createEffect only fires on conception-path change. */
  handleRefresh: () => void;
  handlePick: () => Promise<void>;
  runInit: (path: string) => Promise<void>;
  /** The quit confirmation (a ConfirmModal) already surfaces the noteDirty
   *  warning inline, so by the time the user clicks Quit they've accepted
   *  both stakes. No second confirm. */
  handleConfirmQuit: () => void;
}

export function useConception(deps: UseConceptionDeps): UseConception {
  const reloadAll = async (): Promise<void> => {
    // Panes that own their own createResource (agents / tasks) or push-refresh
    // signal (logs) are kicked off synchronously — they don't return a promise
    // to await alongside the store reloads.
    deps.reloadAgents();
    deps.reloadTasks();
    deps.reloadLogs();
    await Promise.all([
      deps.reloadProjects(),
      deps.knowledgeStore.reload(),
      deps.resourcesStore.reload(),
      deps.skillsStore.reload(),
      deps.reloadConfig(),
      deps.reloadRepos(),
    ]);
  };

  const handleRefresh = (): void => {
    void window.condash.invalidateGitStatus();
    void reloadAll();
  };

  const runInit = async (path: string): Promise<void> => {
    try {
      const { created } = await window.condash.initConception(path);
      deps.flashToast(
        `Initialised conception template — ${created.length} files created.`,
        'success',
      );
      void reloadAll();
    } catch (err) {
      deps.flashToast(`Init failed: ${(err as Error).message}`, 'error');
    }
  };

  const handlePick = async (): Promise<void> => {
    const picked = await window.condash.pickConceptionPath();
    if (!picked) return;
    const prior = deps.conceptionPath();
    deps.setConceptionPath(picked);
    // Picking the same path is a "refresh me" gesture — the per-store
    // createEffect only fires on actual change, so fan out a full reload
    // to honour that.
    if (prior === picked) void reloadAll();

    // Surface the bundled-template init when the picked folder lacks the
    // conception markers (projects/ + condash.json). Init never overwrites
    // — existing files stay put. The ConfirmModal replaces window.confirm
    // so the dialog stays inside the renderer (no native chrome flash,
    // keyboard handling matches the rest of the app).
    try {
      const state = await window.condash.detectConceptionState(picked);
      if (state.pathExists && !state.looksInitialised) {
        const missing: string[] = [];
        if (!state.hasProjects) missing.push('projects/');
        if (!state.hasConfiguration) missing.push('condash.json');
        deps.setInitConfirmState({ path: picked, missing });
      }
    } catch (err) {
      deps.flashToast(`Init check failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleConfirmQuit = (): void => {
    void window.condash.quitApp();
  };

  return { reloadAll, handleRefresh, handlePick, runInit, handleConfirmQuit };
}
