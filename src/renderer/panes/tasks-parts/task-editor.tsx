import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Agent, RunMode } from '@shared/types';
import { extractMarkers } from '@shared/tasks';
import { parseCadence } from '@shared/cadence';
import { slugify } from '@shared/slug';
import { ConfirmModal } from '../../confirm-modal';
import { Modal } from '../../modal';
import { ActionBar, Button } from '../../actions';
import { MarkerChip } from './badges';
import { formatCadence, RUN_MODE_CHOICES, TIMEOUT_CHOICES } from './data';
import type { Draft } from './data';

/** Editor — create / rename / update a task's name, slug, agent, submit flag,
 *  and prompt. Shows the markers parsed from the prompt as the author types.
 *  Renders through the shared `<Modal>` shell; Esc defers to the delete-confirm
 *  dialog when it is open (its own shell closes it first). */
export function TaskEditor(props: {
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

  // Esc closes the editor — but defer to the delete-confirm dialog when it is
  // open. The shell's Esc handler still fires the confirm's own (same-target
  // listeners both run), so the confirm closes and this no-ops, matching the
  // pre-shell behaviour.
  const close = (): void => {
    if (!confirmDelete()) props.onCancel();
  };

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

  // Parsed schedule cadence (ms) driving the live computed-value readout beside
  // the field; null when the text isn't a valid `<n><s|m|h|d>` cadence (or is
  // blank), which the readout surfaces as an "unrecognised" hint.
  const scheduleMs = createMemo(() => parseCadence(d().schedule));

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
    <Modal
      class="tasks-editor-modal"
      ariaLabel={d().editingSlug ? `Edit ${d().editingSlug}` : 'New task'}
      title={d().editingSlug ? `Edit ${d().editingSlug}` : 'New task'}
      onClose={close}
    >
      <section class="tasks-editor">
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
            <span>Schedule (e.g. 5m / 2h / 1d — blank = off)</span>
            <input
              type="text"
              value={d().schedule}
              placeholder="off"
              onInput={(e) => props.patch({ schedule: e.currentTarget.value })}
            />
            <Show when={d().schedule.trim()}>
              <Show
                when={scheduleMs() !== null}
                fallback={
                  <small class="tasks-schedule-hint invalid">
                    unrecognised cadence — use a number + s / m / h / d (e.g. 5m, 2h, 1d)
                  </small>
                }
              >
                <small class="tasks-schedule-hint">
                  runs every {formatCadence(scheduleMs() ?? 0)}
                </small>
              </Show>
            </Show>
          </label>

          <label title="Default for this task's runs (a prompt-seeding agent only); overridable per run. Interactive keeps the tab open (--prompt); one-shot runs once and exits (--run) — prefer one-shot for a scheduled task so its headless run exits cleanly.">
            <span>Run mode</span>
            <select
              value={d().runMode}
              onChange={(e) => props.patch({ runMode: e.currentTarget.value as RunMode })}
            >
              <For each={RUN_MODE_CHOICES}>{(o) => <option value={o.value}>{o.label}</option>}</For>
            </select>
          </label>

          <Show when={d().schedule.trim()}>
            <label title="A scheduled run is killed and discarded once this elapses — keep it ≤ the schedule interval">
              <span>Run timeout</span>
              <select
                value={d().timeout}
                onChange={(e) => props.patch({ timeout: e.currentTarget.value })}
              >
                <For each={TIMEOUT_CHOICES}>
                  {(o) => <option value={o.value}>{o.label}</option>}
                </For>
              </select>
            </label>

            <label
              class="tasks-editor-checkbox"
              title="Skip a scheduled tick when no open tab produced new output since the last run — the changed tabs are handed to the run as {UPDATED_TABS}. Leave off to run on every interval. Enable only for a task that acts on {UPDATED_TABS}."
            >
              <input
                type="checkbox"
                checked={d().gateOnUpdatedTabs}
                onChange={(e) => props.patch({ gateOnUpdatedTabs: e.currentTarget.checked })}
              />
              <span>Only run when a tab changed (skip idle ticks)</span>
            </label>
          </Show>

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

        <ActionBar class="tasks-editor-actions">
          <Show when={d().editingSlug}>
            <Button
              type="button"
              variant="danger"
              size="sm"
              class="tasks-editor-delete"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </Show>
          <Button type="button" variant="default" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={props.onSave}>
            Save
          </Button>
        </ActionBar>

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
    </Modal>
  );
}
