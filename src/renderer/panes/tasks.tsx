import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Agent, Project, RunningTaskRun } from '@shared/types';
import {
  extractMarkers,
  isAppToken,
  isProjectToken,
  isProvidedToken,
  type TaskDef,
  type TaskListItem,
} from '@shared/tasks';
import { isValidSlugTail } from '@shared/slug';
import { AgentBadge, MarkerChip } from './tasks-parts/badges';
import { blankDraft, DEFAULT_TIMEOUT } from './tasks-parts/data';
import type { AppOption, Draft, FillState, RunOptions } from './tasks-parts/data';
import { TaskEditor } from './tasks-parts/task-editor';
import { TaskFill } from './tasks-parts/task-fill';
import { TaskRunning } from './tasks-parts/task-running';
import { ConfirmModal } from '../confirm-modal';
import './tasks-pane.css';

/**
 * Tasks pane. Lists the tasks defined under `<conception>/tasks/`, each a
 * referenced agent plus a markdown prompt with fillable `{markers}`. Three
 * modes share the pane: the card list, a fill view (pickers + prefilled fields
 * + live preview → Run), and an editor (name / slug / agent / prompt). Modeled
 * on the Agents pane. The fill / editor popups and the running-runs dock live
 * in `tasks-parts/`; this file owns the list + the create/edit/fill/save/delete
 * orchestration.
 */
export function TasksView(props: {
  /** Current task list (slug / name / agent / presence / markers). */
  tasks: () => readonly TaskListItem[];
  /** Re-fetch the task list after a mutation. */
  reload: () => void;
  /** Whether a conception is active (tasks are conception-scoped). */
  hasConception: () => boolean;
  /** Conception root — used to compute `{PROJECT_PATH}` (rel path). */
  conceptionPath: () => string | null;
  /** Agents available to reference (editor select + dangling check). */
  agents: () => readonly Agent[];
  /** Projects available to the `{PROJECT}` picker. */
  projects: () => readonly Project[];
  /** Apps available to the `{APP}` picker. */
  apps: () => readonly AppOption[];
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
  /** Run a filled task: spawn the agent (by id) and deliver the substituted
   *  prompt. `taskName` titles the spawned tab. `opts` carries the task slug,
   *  effective excludeFromLogs (routes a flagged run's log to
   *  `.condash/manual/<slug>/`), and the effective runMode (`--prompt`
   *  interactive vs `--run` one-shot). */
  onRun: (agentId: string, text: string, taskName: string, opts: RunOptions) => void;
  /** Report nested-dialog ownership to the full-window shell. */
  onChildOpen?: (open: boolean) => void;
  /** Guard overlay replacement and conception switching before disposal. */
  registerLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [fill, setFill] = createSignal<FillState | null>(null);
  const [discardPending, setDiscardPending] = createSignal(false);
  const [mutationPending, setMutationPending] = createSignal(false);
  let mutation: Promise<void> | null = null;
  let settleDiscard: ((allowed: boolean) => void) | null = null;
  let draftBaseline = '';
  let fillBaseline = '';
  let disposed = false;
  let readEpoch = 0;
  const dirty = (): boolean =>
    (draft() !== null && JSON.stringify(draft()) !== draftBaseline) ||
    (fill() !== null && JSON.stringify(fill()) !== fillBaseline);
  const requestLeave = async (): Promise<boolean> => {
    if (mutation) await mutation;
    if (disposed) return false;
    if (draft()?.configSlugsToClear.length) {
      props.flashToast(
        'Save the renamed automation again to finish updating its schedule.',
        'error',
      );
      return false;
    }
    if (discardPending()) return Promise.resolve(false);
    if (!dirty()) return Promise.resolve(true);
    setDiscardPending(true);
    return new Promise((resolve) => {
      settleDiscard = resolve;
    });
  };
  const finishDiscard = (allowed: boolean): void => {
    const resolve = settleDiscard;
    settleDiscard = null;
    setDiscardPending(false);
    resolve?.(allowed);
  };
  const dismissChild = async (): Promise<void> => {
    if (await requestLeave()) {
      setDraft(null);
      setFill(null);
    }
  };
  createEffect(() => props.onChildOpen?.(draft() !== null || fill() !== null || discardPending()));
  props.registerLeaveGuard?.(requestLeave);
  onCleanup(() => {
    disposed = true;
    readEpoch += 1;
    settleDiscard?.(false);
    props.registerLeaveGuard?.(null);
  });

  // Live headless scheduled runs. The scheduler pushes the roster on every run
  // start / exit (B5), so this is push-driven; the slow interval is only a
  // backstop against a missed push (the scheduler is the sole writer, so drift
  // is unlikely). Seeded once on mount.
  const [running, setRunning] = createSignal<readonly RunningTaskRun[]>([]);
  // A monotonic epoch guards against a stale seed/poll snapshot clobbering an
  // authoritative push that lands during the `listRunningTaskRuns()` round trip:
  // a push bumps the epoch, and a refresh only applies its result if the epoch
  // is unchanged since it started (F1). Without this, a start/exit inside the
  // seed window could be reverted for up to a full poll interval.
  let runsEpoch = 0;
  const refreshRunning = async (): Promise<void> => {
    if (disposed) return;
    const epoch = runsEpoch;
    try {
      const runs = await window.condash.listRunningTaskRuns();
      if (!disposed && epoch === runsEpoch) setRunning(runs);
    } catch {
      /* scheduler not ready / no conception — leave the list as-is */
    }
  };
  onMount(() => {
    // Subscribe before the seed so a push during the seed's round trip is kept.
    const offTaskRuns = window.condash.onTaskRuns((runs) => {
      runsEpoch += 1;
      setRunning(runs);
    });
    void refreshRunning();
    const poll = setInterval(() => void refreshRunning(), 30000);
    onCleanup(() => {
      offTaskRuns();
      clearInterval(poll);
    });
  });
  const killRun = async (sid: string): Promise<void> => {
    await window.condash.killTaskRun(sid).catch(() => undefined);
    void refreshRunning();
  };

  const patch = (p: Partial<Draft>): void => {
    if (mutation || disposed) return;
    setDraft((d) => (d ? { ...d, ...p } : d));
  };

  const startCreate = (): void => {
    if (mutation || disposed) return;
    readEpoch += 1;
    setFill(null);
    const initial = blankDraft(props.agents());
    draftBaseline = JSON.stringify(initial);
    setDraft(initial);
  };

  const startEdit = async (slug: string): Promise<void> => {
    if (mutation || disposed) return;
    const epoch = ++readEpoch;
    setFill(null);
    const def = await window.condash.readTask(slug);
    if (disposed || epoch !== readEpoch) return;
    if (!def) {
      props.flashToast(`Task ${slug} not found`, 'error');
      return;
    }
    const cfg = (await window.condash.getTaskConfig())[slug] ?? {};
    if (disposed || epoch !== readEpoch) return;
    const initial: Draft = {
      slug,
      slugDirty: true,
      name: def.name,
      agent: def.agent,
      prompt: def.prompt,
      editingSlug: slug,
      configSlugsToClear: [],
      schedule: cfg.schedule ?? '',
      timeout: cfg.timeout ?? DEFAULT_TIMEOUT,
      excludeFromLogs: cfg.excludeFromLogs === true,
      runMode: cfg.runMode === 'oneshot' ? 'oneshot' : 'interactive',
      gateOnUpdatedTabs: cfg.gateOnUpdatedTabs === true,
    };
    draftBaseline = JSON.stringify(initial);
    setDraft(initial);
  };

  const startFill = async (slug: string): Promise<void> => {
    if (mutation || disposed) return;
    const epoch = ++readEpoch;
    setDraft(null);
    const def = await window.condash.readTask(slug);
    if (disposed || epoch !== readEpoch) return;
    if (!def) {
      props.flashToast(`Task ${slug} not found`, 'error');
      return;
    }
    const fields: Record<string, string> = {};
    for (const marker of extractMarkers(def.prompt)) {
      if (isAppToken(marker.key) || isProjectToken(marker.key) || isProvidedToken(marker.key)) {
        continue;
      }
      fields[marker.key] = marker.default;
    }
    // Seed `{TABS}` and the excludeFromLogs default. Both come from runtime
    // state, fetched once when the popup opens (the open-tab set is stable
    // enough for the duration of a fill).
    const [tabs, cfgMap] = await Promise.all([
      window.condash.termTabsContext(),
      window.condash.getTaskConfig(),
    ]);
    if (disposed || epoch !== readEpoch) return;
    // A manual run has no per-task "since last run" watermark (that lives in the
    // scheduler), so `{UPDATED_TABS}` seeds to the full open set — the user
    // asked to run now, so treat every tab as worth acting on.
    const tabsJson = JSON.stringify(tabs);
    const provided: Record<string, string> = { TABS: tabsJson, UPDATED_TABS: tabsJson };
    const excludeFromLogs = cfgMap[slug]?.excludeFromLogs === true;
    const runMode = cfgMap[slug]?.runMode === 'oneshot' ? 'oneshot' : 'interactive';
    const initial: FillState = {
      slug,
      def,
      agent: def.agent,
      app: null,
      project: null,
      fields,
      provided,
      excludeFromLogs,
      runMode,
    };
    fillBaseline = JSON.stringify(initial);
    setFill(initial);
  };

  const runMutation = (operation: () => Promise<void>): Promise<void> => {
    setMutationPending(true);
    readEpoch += 1;
    mutation = operation().finally(() => {
      mutation = null;
      if (!disposed) setMutationPending(false);
    });
    return mutation;
  };

  const save = async (): Promise<void> => {
    if (mutation || disposed) return;
    const d = draft();
    if (!d) return;
    if (!d.name.trim()) {
      props.flashToast('Name is required', 'error');
      return;
    }
    if (!d.agent.trim()) {
      props.flashToast('Pick an agent', 'error');
      return;
    }
    if (!isValidSlugTail(d.slug)) {
      props.flashToast('Slug must be lowercase letters, digits, and single hyphens', 'error');
      return;
    }
    const def: TaskDef = {
      name: d.name.trim(),
      agent: d.agent,
      prompt: d.prompt,
    };
    await runMutation(async () => {
      try {
        const slug = await window.condash.writeTask(d.slug, def, d.editingSlug ?? undefined);
        const configSlugsToClear = [
          ...new Set([
            ...d.configSlugsToClear,
            ...(d.editingSlug && d.editingSlug !== slug ? [d.editingSlug] : []),
          ]),
        ].filter((oldSlug) => oldSlug !== slug);
        if (!disposed) {
          setDraft((current) =>
            current
              ? { ...current, slug, slugDirty: true, editingSlug: slug, configSlugsToClear }
              : current,
          );
        }
        // Departure waits for this entire definition/config operation. Persist
        // the destination config before removing prior renamed-slug entries.
        const scheduled = d.schedule.trim();
        await window.condash.setTaskConfig(slug, {
          schedule: scheduled || undefined,
          // Timeout only matters for scheduled headless runs — don't persist it
          // for an unscheduled task.
          timeout: scheduled ? d.timeout.trim() || undefined : undefined,
          excludeFromLogs: d.excludeFromLogs || undefined,
          // Only the non-default mode is persisted (interactive is the default).
          runMode: d.runMode === 'oneshot' ? 'oneshot' : undefined,
          // The gate only matters for a scheduled task; don't persist it otherwise.
          gateOnUpdatedTabs: scheduled ? d.gateOnUpdatedTabs || undefined : undefined,
        });
        for (const oldSlug of configSlugsToClear) await window.condash.setTaskConfig(oldSlug, {});
        if (disposed) return;
        props.flashToast(`Saved ${slug}`, 'success');
        setDraft(null);
        props.reload();
      } catch (err) {
        if (!disposed) props.flashToast(`Save failed: ${(err as Error).message}`, 'error');
      }
    });
  };

  // Delete the task currently open in the editor. Confirmation is handled by the
  // editor's own ConfirmModal before this runs.
  const deleteEditing = async (): Promise<void> => {
    if (mutation || disposed) return;
    const d = draft();
    if (!d?.editingSlug) return;
    const editingSlug = d.editingSlug;
    await runMutation(async () => {
      try {
        await window.condash.deleteTask(editingSlug);
        // Drop any schedule / excludeFromLogs config for the deleted task.
        await window.condash.setTaskConfig(editingSlug, {});
        if (disposed) return;
        props.flashToast(`Deleted ${d.name || d.editingSlug}`, 'success');
        if (fill()?.slug === d.editingSlug) setFill(null);
        setDraft(null);
        props.reload();
      } catch (err) {
        if (!disposed) props.flashToast(`Delete failed: ${(err as Error).message}`, 'error');
      }
    });
  };

  return (
    <div class="tasks-pane">
      <header class="tasks-pane-header">
        <h2>Automations</h2>
        <div class="tasks-pane-actions">
          <button
            type="button"
            class="btn btn--sm btn--default"
            data-tone="add"
            onClick={() => void startCreate()}
            disabled={!props.hasConception()}
          >
            + New automation
          </button>
        </div>
      </header>

      <Show
        when={props.hasConception()}
        fallback={
          <p class="tasks-pane-empty pane-empty">Open a conception to manage automations.</p>
        }
      >
        <Show
          when={props.tasks().length > 0}
          fallback={
            <p class="tasks-pane-empty pane-empty">
              No automations yet. An automation is a referenced agent plus a markdown prompt with
              fillable <code>{'{markers}'}</code>. Click <strong>+ New automation</strong> to define
              one.
            </p>
          }
        >
          <div class="tasks-grid card-grid">
            <For each={props.tasks()}>
              {(task) => (
                <div
                  class="tasks-row tasks-row-clickable card"
                  role="button"
                  tabindex={0}
                  title="Click to edit this task"
                  onClick={() => void startEdit(task.slug)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void startEdit(task.slug);
                    }
                  }}
                >
                  <div class="tasks-row-main">
                    <span class="tasks-row-name">{task.name}</span>
                    <AgentBadge agent={task.agent} present={task.agentPresent} />
                    <Show when={task.markers.length > 0}>
                      <div class="tasks-markers">
                        <For each={task.markers}>{(marker) => <MarkerChip marker={marker} />}</For>
                      </div>
                    </Show>
                  </div>
                  <div class="tasks-row-actions">
                    <button
                      type="button"
                      class="tasks-run btn btn--sm btn--default"
                      data-tone="run"
                      title={
                        task.agentPresent
                          ? 'Fill markers and run'
                          : `Agent ${task.agent} is not defined`
                      }
                      disabled={!task.agentPresent}
                      onClick={(e) => {
                        e.stopPropagation();
                        void startFill(task.slug);
                      }}
                    >
                      Run…
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <TaskRunning runs={running} tasks={props.tasks} onKill={(sid) => void killRun(sid)} />

      <Show when={fill()}>
        {(f) => (
          <TaskFill
            fill={f}
            setFill={setFill}
            agents={props.agents}
            apps={props.apps}
            projects={props.projects}
            conceptionPath={props.conceptionPath}
            onRun={props.onRun}
            onDismiss={() => void dismissChild()}
          />
        )}
      </Show>

      <Show when={draft()}>
        {(d) => (
          <TaskEditor
            busy={mutationPending}
            repairPending={() => d().configSlugsToClear.length > 0}
            draft={d}
            patch={patch}
            agents={props.agents}
            onSave={save}
            onCancel={() => {
              if (!mutation && !d().configSlugsToClear.length) setDraft(null);
            }}
            onDismiss={() => void dismissChild()}
            onDelete={deleteEditing}
          />
        )}
      </Show>
      <Show when={discardPending()}>
        <ConfirmModal
          title="Discard automation edits?"
          body="Unsaved editor or run fields will be lost."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onCancel={() => finishDiscard(false)}
          onConfirm={() => finishDiscard(true)}
        />
      </Show>
    </div>
  );
}
