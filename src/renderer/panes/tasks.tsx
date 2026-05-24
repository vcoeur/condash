import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import type { JSX } from 'solid-js';
import type { AgentListItem } from '@shared/harnesses';
import type { Project } from '@shared/types';
import {
  appContext,
  extractMarkers,
  isAppToken,
  isProjectToken,
  projectTokenContext,
  type Marker,
  type TaskDef,
  type TaskListItem,
} from '@shared/tasks';
import { substitute } from '@shared/action-template';
import { isValidSlugTail, slugify } from '@shared/slug';
import { ConfirmModal } from '../confirm-modal';
import './tasks-pane.css';

/** One app the `{APP}` picker can select. `alias` is the `@<name>` form. */
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
  submit: boolean;
  prompt: string;
  editingSlug: string | null;
}

/** Fill state: the read task plus the picker selections and per-marker field
 *  values that feed substitution. `fields` holds only the plain (non-reserved)
 *  markers — the `{APP_*}` / `{PROJECT_*}` families come from the pickers. */
interface FillState {
  slug: string;
  def: TaskDef;
  app: AppOption | null;
  project: Project | null;
  fields: Record<string, string>;
}

function blankDraft(agents: readonly AgentListItem[]): Draft {
  return {
    slug: '',
    slugDirty: false,
    name: '',
    agent: agents[0]?.slug ?? '',
    submit: true,
    prompt: '',
    editingSlug: null,
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
  agents: () => readonly AgentListItem[];
  /** Projects available to the `{PROJECT}` picker. */
  projects: () => readonly Project[];
  /** Apps available to the `{APP}` picker. */
  apps: () => readonly AppOption[];
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
  /** Run a filled task: spawn the agent (by slug), type the substituted prompt,
   *  submit. */
  onRun: (agentSlug: string, text: string, submit: boolean) => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [fill, setFill] = createSignal<FillState | null>(null);

  const agentExists = (slug: string): boolean => props.agents().some((a) => a.slug === slug);

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
    setDraft({
      slug,
      slugDirty: true,
      name: def.name,
      agent: def.agent,
      submit: def.submit,
      prompt: def.prompt,
      editingSlug: slug,
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
      if (isAppToken(marker.key) || isProjectToken(marker.key)) continue;
      fields[marker.key] = marker.default;
    }
    setFill({ slug, def, app: null, project: null, fields });
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
      submit: d.submit,
      prompt: d.prompt,
    };
    try {
      const slug = await window.condash.writeTask(d.slug, def, d.editingSlug ?? undefined);
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
        </Show>
      </Show>

      <Show when={fill()}>
        {(f) => (
          <TaskFill
            fill={f}
            setFill={setFill}
            apps={props.apps}
            projects={props.projects}
            conceptionPath={props.conceptionPath}
            agentExists={agentExists}
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

/** Fill view — one input per plain marker plus app / project pickers for the
 *  reserved families, a live preview of the substituted prompt, and Run. */
function TaskFill(props: {
  fill: () => FillState;
  setFill: (next: FillState | null) => void;
  apps: () => readonly AppOption[];
  projects: () => readonly Project[];
  conceptionPath: () => string | null;
  agentExists: (name: string) => boolean;
  onRun: (agentName: string, text: string, submit: boolean) => void;
}): JSX.Element {
  const markers = createMemo(() => extractMarkers(props.fill().def.prompt));
  const textMarkers = createMemo(() =>
    markers().filter((m) => !isAppToken(m.key) && !isProjectToken(m.key)),
  );
  const needsApp = createMemo(() => markers().some((m) => isAppToken(m.key)));
  const needsProject = createMemo(() => markers().some((m) => isProjectToken(m.key)));

  const close = (): void => props.setFill(null);

  // Esc closes the run popup.
  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));

  const setField = (key: string, value: string): void => {
    const f = props.fill();
    props.setFill({ ...f, fields: { ...f.fields, [key]: value } });
  };

  const ctx = createMemo<Record<string, string>>(() => ({
    ...appContext(props.fill().app),
    ...projectTokenContext(props.fill().project, props.conceptionPath() ?? undefined),
    ...props.fill().fields,
  }));

  const preview = createMemo(() => substitute(props.fill().def.prompt, ctx()));

  const agentOk = createMemo(() => props.agentExists(props.fill().def.agent));

  const run = (): void => {
    const f = props.fill();
    props.onRun(f.def.agent, substitute(f.def.prompt, ctx()), f.def.submit);
    close();
  };

  return (
    <div class="modal-backdrop" onClick={close}>
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
          <p class="tasks-editor-note">
            Agent: <code>{props.fill().def.agent}</code>
            {props.fill().def.submit ? ' · submits on run' : ' · types without submitting'}
          </p>

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

          <div class="tasks-editor-actions">
            <button
              type="button"
              class="tasks-run"
              disabled={!agentOk()}
              title={
                agentOk()
                  ? 'Spawn the agent and run'
                  : `Agent ${props.fill().def.agent} is not defined`
              }
              onClick={run}
            >
              Run
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
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
  agents: () => readonly AgentListItem[];
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}): JSX.Element {
  const d = props.draft;
  const markers = createMemo(() => extractMarkers(d().prompt));
  const [confirmDelete, setConfirmDelete] = createSignal(false);

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

  // Agent options keyed by slug (the stored identity) with the display name as
  // label. Includes the draft's current slug when it dangles (renamed/removed)
  // so editing doesn't silently drop the reference.
  const agentOptions = createMemo(() => {
    const opts = props.agents().map((a) => ({ slug: a.slug, label: a.name }));
    const current = d().agent;
    if (current && !opts.some((o) => o.slug === current)) {
      return [{ slug: current, label: `${current} (missing)` }, ...opts];
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
    <div class="modal-backdrop" onClick={props.onCancel}>
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
                    {(o) => <option value={o.slug}>{o.label}</option>}
                  </For>
                </Match>
              </Switch>
            </select>
          </label>

          <label class="tasks-checkbox">
            <input
              type="checkbox"
              checked={d().submit}
              onChange={(e) => props.patch({ submit: e.currentTarget.checked })}
            />
            <span>Press Enter after typing (submit)</span>
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

          <Show when={markers().length > 0}>
            <div class="tasks-markers tasks-editor-markers">
              <span class="tasks-preview-label">Markers:</span>
              <For each={markers()}>{(marker) => <MarkerChip marker={marker} />}</For>
            </div>
          </Show>

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
