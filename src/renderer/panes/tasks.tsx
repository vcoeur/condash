import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Agent, Project } from '@shared/types';
import {
  appContext,
  extractMarkers,
  isAppToken,
  isProjectToken,
  isProvidedToken,
  projectTokenContext,
  type Marker,
  type TaskDef,
  type TaskListItem,
} from '@shared/tasks';
import { substitute } from '@shared/action-template';
import { isValidSlugTail, slugify } from '@shared/slug';
import { ConfirmModal } from '../confirm-modal';
import { createBackdropClose } from '../modal-helpers';
import './tasks-pane.css';

/** One app the `{APP}` picker can select. `alias` is the `#<name>` form. */
export interface AppOption {
  alias: string;
  name: string;
  path: string;
}

/** Editor draft. `editingSlug` is null when creating, the prior slug when
 *  editing (so a slug change becomes a rename). `slugDirty` tracks whether the
 *  user has hand-edited the slug, so name-driven auto-slugging stops once they
 *  take over. */
interface Draft {
  slug: string;
  slugDirty: boolean;
  name: string;
  agent: string;
  prompt: string;
  editingSlug: string | null;
  /** Schedule cadence (`30s`/`2m`/`1h`); empty = not scheduled (capability 1).
   *  Persisted to `taskConfig[slug]` in settings.json, not task.json. */
  schedule: string;
  /** Per-task default for routing manual runs out of `.condash/logs/`
   *  (capability 4). Persisted alongside `schedule`. */
  excludeFromLogs: boolean;
}

/** Fill state: the read task plus the picker selections and per-marker field
 *  values that feed substitution. `fields` holds only the plain (non-reserved)
 *  markers — the `{APP_*}` / `{PROJECT_*}` families come from the pickers.
 *  `agent` is the run-time agent id, seeded from the task's stored `def.agent`
 *  but overridable in the run popup. */
interface FillState {
  slug: string;
  def: TaskDef;
  agent: string;
  app: AppOption | null;
  project: Project | null;
  fields: Record<string, string>;
  /** condash-provided substitutions (e.g. `{TABS}`), fetched once when the
   *  fill opens — never user-editable. */
  provided: Record<string, string>;
  /** Effective per-run "route this run out of the logs" flag (capability 4),
   *  seeded from the task's `excludeFromLogs` default and toggleable here. */
  excludeFromLogs: boolean;
}

/** Options carried alongside a task run launch. */
export interface RunOptions {
  taskSlug: string;
  excludeFromLogs: boolean;
}

function blankDraft(agents: readonly Agent[]): Draft {
  // Default a new task to the first prompt-seedable agent — tasks hand the
  // filled prompt to the agent via `--prompt` (see the agent picker's disabled
  // rows), so an agent without `promptFlags` can't carry one.
  const seedable = agents.find((a) => a.promptFlags === true) ?? agents[0];
  return {
    slug: '',
    slugDirty: false,
    name: '',
    agent: seedable?.id ?? '',
    prompt: '',
    editingSlug: null,
    schedule: '',
    excludeFromLogs: false,
  };
}

/**
 * Tasks pane. Lists the tasks defined under `<conception>/tasks/`, each a
 * referenced agent plus a markdown prompt with fillable `{markers}`. Three
 * modes share the pane: the card list, a fill view (pickers + prefilled fields
 * + live preview → Run), and an editor (name / slug / agent / prompt). Modeled
 * on the Agents pane.
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
   *  prompt. `taskName` titles the spawned tab. `opts` carries the task slug +
   *  effective excludeFromLogs so a flagged manual run routes its log to
   *  `.condash/manual/<slug>/`. Always launches interactively. */
  onRun: (agentId: string, text: string, taskName: string, opts: RunOptions) => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [fill, setFill] = createSignal<FillState | null>(null);

  const patch = (p: Partial<Draft>): void => {
    setDraft((d) => (d ? { ...d, ...p } : d));
  };

  const startCreate = (): void => {
    setFill(null);
    setDraft(blankDraft(props.agents()));
  };

  const startEdit = async (slug: string): Promise<void> => {
    setFill(null);
    const def = await window.condash.readTask(slug);
    if (!def) {
      props.flashToast(`Task ${slug} not found`, 'error');
      return;
    }
    const cfg = (await window.condash.getTaskConfig())[slug] ?? {};
    setDraft({
      slug,
      slugDirty: true,
      name: def.name,
      agent: def.agent,
      prompt: def.prompt,
      editingSlug: slug,
      schedule: cfg.schedule ?? '',
      excludeFromLogs: cfg.excludeFromLogs === true,
    });
  };

  const startFill = async (slug: string): Promise<void> => {
    setDraft(null);
    const def = await window.condash.readTask(slug);
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
    // A manual run has no per-task "since last run" watermark (that lives in the
    // scheduler), so `{UPDATED_TABS}` seeds to the full open set — the user
    // asked to run now, so treat every tab as worth acting on.
    const tabsJson = JSON.stringify(tabs);
    const provided: Record<string, string> = { TABS: tabsJson, UPDATED_TABS: tabsJson };
    const excludeFromLogs = cfgMap[slug]?.excludeFromLogs === true;
    setFill({
      slug,
      def,
      agent: def.agent,
      app: null,
      project: null,
      fields,
      provided,
      excludeFromLogs,
    });
  };

  const save = async (): Promise<void> => {
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
    try {
      const slug = await window.condash.writeTask(d.slug, def, d.editingSlug ?? undefined);
      // Persist schedule / excludeFromLogs to settings.json's taskConfig under
      // the *resolved* slug (a rename moves the config with the task). When the
      // slug changed, clear the old entry.
      if (d.editingSlug && d.editingSlug !== slug) {
        await window.condash.setTaskConfig(d.editingSlug, {});
      }
      await window.condash.setTaskConfig(slug, {
        schedule: d.schedule.trim() || undefined,
        excludeFromLogs: d.excludeFromLogs || undefined,
      });
      props.flashToast(`Saved ${slug}`, 'success');
      setDraft(null);
      props.reload();
    } catch (err) {
      props.flashToast(`Save failed: ${(err as Error).message}`, 'error');
    }
  };

  // Delete the task currently open in the editor. Confirmation is handled by the
  // editor's own ConfirmModal before this runs.
  const deleteEditing = async (): Promise<void> => {
    const d = draft();
    if (!d?.editingSlug) return;
    try {
      await window.condash.deleteTask(d.editingSlug);
      // Drop any schedule / excludeFromLogs config for the deleted task.
      await window.condash.setTaskConfig(d.editingSlug, {});
      props.flashToast(`Deleted ${d.name || d.editingSlug}`, 'success');
      if (fill()?.slug === d.editingSlug) setFill(null);
      setDraft(null);
      props.reload();
    } catch (err) {
      props.flashToast(`Delete failed: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div class="tasks-pane">
      <header class="tasks-pane-header">
        <h2>Tasks</h2>
        <div class="tasks-pane-actions">
          <button
            type="button"
            onClick={() => void startCreate()}
            disabled={!props.hasConception()}
          >
            + New task
          </button>
        </div>
      </header>

      <Show
        when={props.hasConception()}
        fallback={<p class="tasks-pane-empty">Open a conception to manage its tasks.</p>}
      >
        <Show
          when={props.tasks().length > 0}
          fallback={
            <p class="tasks-pane-empty">
              No tasks yet. A task is a referenced agent plus a markdown prompt with fillable{' '}
              <code>{'{markers}'}</code>. Click <strong>+ New task</strong> to define one.
            </p>
          }
        >
          <div class="tasks-grid">
            <For each={props.tasks()}>
              {(task) => (
                <div
                  class="tasks-row tasks-row-clickable"
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
                      class="tasks-run"
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
          />
        )}
      </Show>

      <Show when={draft()}>
        {(d) => (
          <TaskEditor
            draft={d}
            patch={patch}
            agents={props.agents}
            onSave={save}
            onCancel={() => setDraft(null)}
            onDelete={deleteEditing}
          />
        )}
      </Show>
    </div>
  );
}

function AgentBadge(props: { agent: string; present: boolean }): JSX.Element {
  return (
    <Show
      when={props.present}
      fallback={
        <span class="tasks-agent tasks-agent-missing" title={`Agent ${props.agent} is not defined`}>
          {props.agent} missing
        </span>
      }
    >
      <span class="tasks-agent tasks-agent-ok">{props.agent}</span>
    </Show>
  );
}

function MarkerChip(props: { marker: Marker }): JSX.Element {
  const kind = (): string => {
    if (isAppToken(props.marker.key)) return 'app';
    if (isProjectToken(props.marker.key)) return 'project';
    return 'field';
  };
  return (
    <span class="tasks-marker" data-kind={kind()} title={`${kind()} marker`}>
      {`{${props.marker.key}}`}
    </span>
  );
}

/** Fill view — a top control row (agent picker + Run) above the variable
 *  settings (app / project pickers + one input per plain marker), with a live
 *  preview of the substituted prompt at the bottom. The agent defaults to the
 *  task's stored agent but can be overridden here at run time. */
function TaskFill(props: {
  fill: () => FillState;
  setFill: (next: FillState | null) => void;
  agents: () => readonly Agent[];
  apps: () => readonly AppOption[];
  projects: () => readonly Project[];
  conceptionPath: () => string | null;
  onRun: (agentId: string, text: string, taskName: string, opts: RunOptions) => void;
}): JSX.Element {
  // Derive markers from the prompt alone, not the whole fill signal. The prompt
  // is immutable during a fill session, so this `prompt` memo's `===` output is
  // stable across field edits — `extractMarkers` (which allocates fresh Marker
  // objects) therefore stops re-running on every keystroke. That keeps the
  // marker arrays referentially stable so the `<For>` over `textMarkers` does
  // not recreate the param `<input>`s, which would otherwise drop focus after a
  // single character.
  const prompt = createMemo(() => props.fill().def.prompt);
  const markers = createMemo(() => extractMarkers(prompt()));
  const textMarkers = createMemo(() =>
    markers().filter(
      (m) => !isAppToken(m.key) && !isProjectToken(m.key) && !isProvidedToken(m.key),
    ),
  );
  const needsApp = createMemo(() => markers().some((m) => isAppToken(m.key)));
  const needsProject = createMemo(() => markers().some((m) => isProjectToken(m.key)));

  const close = (): void => props.setFill(null);
  const backdrop = createBackdropClose(close);

  // Esc closes the run popup.
  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));

  // Run-time agent choices, keyed by id like the editor: only prompt-seedable
  // agents are selectable (a task hands its prompt via `--prompt`), with the
  // current selection kept selectable even if it dangles.
  const agentOptions = createMemo(() => {
    const opts = props
      .agents()
      .map((a) => ({ id: a.id, label: a.label, promptFlags: a.promptFlags === true }));
    const current = props.fill().agent;
    if (current && !opts.some((o) => o.id === current)) {
      return [{ id: current, label: `${current} (missing)`, promptFlags: false }, ...opts];
    }
    return opts;
  });

  const setField = (key: string, value: string): void => {
    const f = props.fill();
    props.setFill({ ...f, fields: { ...f.fields, [key]: value } });
  };

  const ctx = createMemo<Record<string, string>>(() => ({
    ...props.fill().provided,
    ...appContext(props.fill().app),
    ...projectTokenContext(props.fill().project, props.conceptionPath() ?? undefined),
    ...props.fill().fields,
  }));

  const preview = createMemo(() => substitute(props.fill().def.prompt, ctx()));

  const agentOk = createMemo(() => props.agents().some((a) => a.id === props.fill().agent));

  const run = (): void => {
    const f = props.fill();
    props.onRun(f.agent, substitute(f.def.prompt, ctx()), f.def.name, {
      taskSlug: f.slug,
      excludeFromLogs: f.excludeFromLogs,
    });
    close();
  };

  return (
    <div class="modal-backdrop" onMouseDown={backdrop.onMouseDown} onClick={backdrop.onClick}>
      <div
        class="modal tasks-fill-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Run ${props.fill().def.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <section class="tasks-editor tasks-fill">
          <header>
            <h3>Run {props.fill().def.name}</h3>
            <button type="button" onClick={close}>
              Close
            </button>
          </header>

          {/* Top control row: pick the agent and run, above the variable
              settings. The prompt preview stays at the bottom. */}
          <div class="tasks-fill-top">
            <label>
              <span>Agent</span>
              <select
                value={props.fill().agent}
                onChange={(e) => props.setFill({ ...props.fill(), agent: e.currentTarget.value })}
              >
                <Switch>
                  <Match when={agentOptions().length === 0}>
                    <option value="">(no agents defined)</option>
                  </Match>
                  <Match when={agentOptions().length > 0}>
                    <For each={agentOptions()}>
                      {(o) => (
                        <option
                          value={o.id}
                          disabled={!o.promptFlags && o.id !== props.fill().agent}
                        >
                          {o.promptFlags ? o.label : `${o.label} — no prompt seeding`}
                        </option>
                      )}
                    </For>
                  </Match>
                </Switch>
              </select>
            </label>
            <label
              class="tasks-fill-exclude"
              title="Route this run's log to .condash/manual/<slug>/ instead of the normal logs"
            >
              <input
                type="checkbox"
                checked={props.fill().excludeFromLogs}
                onChange={(e) =>
                  props.setFill({ ...props.fill(), excludeFromLogs: e.currentTarget.checked })
                }
              />
              <span>Keep out of logs</span>
            </label>
            <button
              type="button"
              class="tasks-run tasks-fill-run"
              disabled={!agentOk()}
              title={
                agentOk()
                  ? 'Spawn the agent and run interactively'
                  : `Agent ${props.fill().agent} is not defined`
              }
              onClick={run}
            >
              Run
            </button>
          </div>

          <div class="tasks-fill-scroll">
            <Show when={needsApp()}>
              <label>
                <span>App {'{APP}'}</span>
                <select
                  value={props.fill().app?.alias ?? ''}
                  onChange={(e) => {
                    const alias = e.currentTarget.value;
                    const app = props.apps().find((a) => a.alias === alias) ?? null;
                    props.setFill({ ...props.fill(), app });
                  }}
                >
                  <option value="">(pick an app)</option>
                  <For each={props.apps()}>{(a) => <option value={a.alias}>{a.alias}</option>}</For>
                </select>
              </label>
            </Show>

            <Show when={needsProject()}>
              <label>
                <span>Project {'{PROJECT}'}</span>
                <select
                  value={props.fill().project?.slug ?? ''}
                  onChange={(e) => {
                    const slug = e.currentTarget.value;
                    const project = props.projects().find((p) => p.slug === slug) ?? null;
                    props.setFill({ ...props.fill(), project });
                  }}
                >
                  <option value="">(pick a project)</option>
                  <For each={props.projects()}>
                    {(p) => <option value={p.slug}>{p.title || p.slug}</option>}
                  </For>
                </select>
              </label>
            </Show>

            <For each={textMarkers()}>
              {(marker) => (
                <label>
                  <span>{`{${marker.key}}`}</span>
                  <input
                    type="text"
                    value={props.fill().fields[marker.key] ?? ''}
                    onInput={(e) => setField(marker.key, e.currentTarget.value)}
                  />
                </label>
              )}
            </For>

            <div class="tasks-config-view tasks-preview">
              <span class="tasks-preview-label">Prompt to run:</span>
              <pre>{preview()}</pre>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Editor — create / rename / update a task's name, slug, agent, submit flag,
 *  and prompt. Shows the markers parsed from the prompt as the author types. */
function TaskEditor(props: {
  draft: () => Draft;
  patch: (p: Partial<Draft>) => void;
  agents: () => readonly Agent[];
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}): JSX.Element {
  const d = props.draft;
  const markers = createMemo(() => extractMarkers(d().prompt));
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const backdrop = createBackdropClose(props.onCancel);

  // Esc closes the editor — but defer to the delete-confirm dialog when it is
  // open (its own handler closes it first).
  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !confirmDelete()) {
      event.preventDefault();
      props.onCancel();
    }
  };
  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));

  // Agent options keyed by id (the stored identity) with the display label and
  // whether the agent is prompt-seedable. Includes the draft's current id when
  // it dangles (renamed/removed) so editing doesn't silently drop the reference.
  const agentOptions = createMemo(() => {
    const opts = props
      .agents()
      .map((a) => ({ id: a.id, label: a.label, promptFlags: a.promptFlags === true }));
    const current = d().agent;
    if (current && !opts.some((o) => o.id === current)) {
      return [{ id: current, label: `${current} (missing)`, promptFlags: false }, ...opts];
    }
    return opts;
  });

  const onName = (value: string): void => {
    // Auto-derive the slug from the name until the user hand-edits it (new
    // tasks only — an existing slug stays put).
    if (d().editingSlug === null && !d().slugDirty) {
      props.patch({ name: value, slug: slugify(value) });
    } else {
      props.patch({ name: value });
    }
  };

  return (
    <div class="modal-backdrop" onMouseDown={backdrop.onMouseDown} onClick={backdrop.onClick}>
      <div
        class="modal tasks-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label={d().editingSlug ? `Edit ${d().editingSlug}` : 'New task'}
        onClick={(e) => e.stopPropagation()}
      >
        <section class="tasks-editor">
          <header>
            <h3>{d().editingSlug ? `Edit ${d().editingSlug}` : 'New task'}</h3>
          </header>

          <div class="tasks-editor-scroll">
            <label>
              <span>Name</span>
              <input type="text" value={d().name} onInput={(e) => onName(e.currentTarget.value)} />
            </label>

            <label>
              <span>Slug (directory under tasks/)</span>
              <input
                type="text"
                value={d().slug}
                placeholder="refresh-app-docs"
                onInput={(e) => props.patch({ slug: e.currentTarget.value, slugDirty: true })}
              />
            </label>

            <label>
              <span>Agent</span>
              <select
                value={d().agent}
                onChange={(e) => props.patch({ agent: e.currentTarget.value })}
              >
                <Switch>
                  <Match when={agentOptions().length === 0}>
                    <option value="">(no agents defined)</option>
                  </Match>
                  <Match when={agentOptions().length > 0}>
                    <For each={agentOptions()}>
                      {(o) => (
                        // Only prompt-seedable agents can carry a task prompt. Show
                        // the rest disabled (kept visible for context), except the
                        // current selection, which must stay selectable so the bound
                        // value never lands on a disabled option.
                        <option value={o.id} disabled={!o.promptFlags && o.id !== d().agent}>
                          {o.promptFlags ? o.label : `${o.label} — no prompt seeding`}
                        </option>
                      )}
                    </For>
                  </Match>
                </Switch>
              </select>
            </label>

            <label>
              <span>Prompt (markdown with {'{MARKERS}'})</span>
              <textarea
                class="tasks-prompt-textarea"
                spellcheck={false}
                value={d().prompt}
                placeholder={'Review {APP} and update its docs. Focus: {AREA:CLAUDE.md and docs/}'}
                onInput={(e) => props.patch({ prompt: e.currentTarget.value })}
              />
            </label>

            <label>
              <span>Schedule (e.g. 2m / 30s / 1h — blank = off)</span>
              <input
                type="text"
                value={d().schedule}
                placeholder="off"
                onInput={(e) => props.patch({ schedule: e.currentTarget.value })}
              />
            </label>

            <label class="tasks-editor-checkbox">
              <input
                type="checkbox"
                checked={d().excludeFromLogs}
                onChange={(e) => props.patch({ excludeFromLogs: e.currentTarget.checked })}
              />
              <span>Keep manual runs out of the normal logs (default — overridable per run)</span>
            </label>

            <Show when={markers().length > 0}>
              <div class="tasks-markers tasks-editor-markers">
                <span class="tasks-preview-label">Markers:</span>
                <For each={markers()}>{(marker) => <MarkerChip marker={marker} />}</For>
              </div>
            </Show>
          </div>

          <div class="tasks-editor-actions">
            <button type="button" onClick={props.onSave}>
              Save
            </button>
            <button type="button" onClick={props.onCancel}>
              Cancel
            </button>
            <Show when={d().editingSlug}>
              <button
                type="button"
                class="tasks-danger tasks-editor-delete"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            </Show>
          </div>

          <Show when={confirmDelete()}>
            <ConfirmModal
              title={`Delete task ${d().name || d().editingSlug}?`}
              body="Removes the task directory (task.json + prompt.md)."
              confirmLabel="Delete"
              destructive
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => {
                setConfirmDelete(false);
                props.onDelete();
              }}
            />
          </Show>
        </section>
      </div>
    </div>
  );
}
