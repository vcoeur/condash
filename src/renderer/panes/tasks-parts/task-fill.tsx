import { createMemo, For, Match, Show, Switch } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Agent, Project, RunMode } from '@shared/types';
import {
  appContext,
  extractMarkers,
  isAppToken,
  isProjectToken,
  isProvidedToken,
  projectTokenContext,
} from '@shared/tasks';
import { substitute } from '@shared/action-template';
import { Modal } from '../../modal';
import { RUN_MODE_CHOICES } from './data';
import type { AppOption, FillState, RunOptions } from './data';

/** Fill view — a top control row (agent picker + Run) above the variable
 *  settings (app / project pickers + one input per plain marker), with a live
 *  preview of the substituted prompt at the bottom. The agent defaults to the
 *  task's stored agent but can be overridden here at run time. Renders through
 *  the shared `<Modal>` shell (backdrop / head / Esc / drag-out-safe dismiss). */
export function TaskFill(props: {
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

  // Substitution context for the *preview* — the user-resolved markers (app /
  // project pickers + plain fields) but **not** the condash-provided tokens
  // (`{TABS}` / `{UPDATED_TABS}`). Those stay literal in the shown prompt; a
  // multi-KB JSON dump would drown the preview and they aren't known until the
  // run fires anyway. They are filled in `runCtx` below, at run time only.
  const previewCtx = createMemo<Record<string, string>>(() => ({
    ...appContext(props.fill().app),
    ...projectTokenContext(props.fill().project, props.conceptionPath() ?? undefined),
    ...props.fill().fields,
  }));

  const preview = createMemo(() => substitute(props.fill().def.prompt, previewCtx()));

  const agentOk = createMemo(() => props.agents().some((a) => a.id === props.fill().agent));
  // Run mode (--prompt vs --run) only applies to a prompt-seeding agent; an opaque
  // agent uses the keystroke path, which is interactive-only.
  const fillAgentSeedable = createMemo(() =>
    props.agents().some((a) => a.id === props.fill().agent && a.promptFlags === true),
  );

  const run = (): void => {
    const f = props.fill();
    // Run-time context: the preview markers plus the condash-provided tokens
    // (`{TABS}` / `{UPDATED_TABS}`), which are substituted only now — never in
    // the preview. Provided first so a plain field can't shadow them.
    const runCtx = { ...f.provided, ...previewCtx() };
    props.onRun(f.agent, substitute(f.def.prompt, runCtx), f.def.name, {
      taskSlug: f.slug,
      excludeFromLogs: f.excludeFromLogs,
      runMode: f.runMode,
    });
    close();
  };

  return (
    <Modal
      class="tasks-fill-modal"
      ariaLabel={`Run ${props.fill().def.name}`}
      title={`Run ${props.fill().def.name}`}
      onClose={close}
    >
      <section class="tasks-editor tasks-fill">
        {/* Top control row: pick the agent and run, above the variable
            settings. The prompt preview stays at the bottom. */}
        <div class="tasks-fill-top">
          <label class="tasks-fill-agent">
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
                      <option value={o.id} disabled={!o.promptFlags && o.id !== props.fill().agent}>
                        {o.promptFlags ? o.label : `${o.label} — no prompt seeding`}
                      </option>
                    )}
                  </For>
                </Match>
              </Switch>
            </select>
          </label>
          <label
            class="tasks-fill-mode"
            title={
              fillAgentSeedable()
                ? 'Interactive keeps the tab open (--prompt); one-shot runs once and exits (--run)'
                : 'Run mode needs a prompt-seeding agent (promptFlags); opaque agents are interactive only'
            }
          >
            <select
              value={props.fill().runMode}
              disabled={!fillAgentSeedable()}
              onChange={(e) =>
                props.setFill({ ...props.fill(), runMode: e.currentTarget.value as RunMode })
              }
            >
              <For each={RUN_MODE_CHOICES}>{(o) => <option value={o.value}>{o.label}</option>}</For>
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
              !agentOk()
                ? `Agent ${props.fill().agent} is not defined`
                : props.fill().runMode === 'oneshot'
                  ? 'Spawn the agent, run once, and exit (--run)'
                  : 'Spawn the agent and run interactively (--prompt)'
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
    </Modal>
  );
}
