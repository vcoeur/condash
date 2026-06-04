import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import type { ProjectCreateInput, ProjectCreateResult } from '@shared/types';
import { slugify, isValidSlugTail } from '@shared/slug';
import { Modal } from './modal';
import { ActionBar, Button } from './actions';
import './new-project-modal.css';

type Kind = ProjectCreateInput['kind'];
type Status = ProjectCreateInput['status'];
type Environment = NonNullable<ProjectCreateInput['environment']>;
type Severity = NonNullable<ProjectCreateInput['severity']>;

const KINDS: readonly Kind[] = ['project', 'incident', 'document'];
const STATUSES: readonly Status[] = ['now', 'review', 'later', 'backlog'];
const ENVIRONMENTS: readonly Environment[] = ['PROD', 'STAGING', 'DEV'];
const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high'];

/**
 * Minimal-info "+ New project" modal. Captures Title (required), Kind
 * (default project), Status (default now). Slug is derived from Title via
 * `slugify` and shown as a read-only preview with an "edit" toggle. Apps,
 * Branch, Base intentionally absent — users fill them in by editing the
 * README or via the popup. For Kind = incident, Environment / Severity /
 * Severity-impact are revealed inline.
 */
export function NewProjectModal(props: {
  onCreated: (result: ProjectCreateResult) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = createSignal('');
  const [kind, setKind] = createSignal<Kind>('project');
  const [status, setStatus] = createSignal<Status>('now');
  const [environment, setEnvironment] = createSignal<Environment>('PROD');
  const [severity, setSeverity] = createSignal<Severity>('medium');
  const [severityImpact, setSeverityImpact] = createSignal('');
  const [slugOverride, setSlugOverride] = createSignal<string | null>(null);
  const [editingSlug, setEditingSlug] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let titleRef: HTMLInputElement | undefined;
  let slugRef: HTMLInputElement | undefined;

  // Esc → close, backdrop dismissal, and the close button are owned by the
  // shared <Modal> shell via this guarded handler — `busy()` blocks dismissal
  // mid-create so a stray Esc / click can't cancel an in-flight submit.
  const requestClose = (): void => {
    if (busy()) return;
    props.onClose();
  };

  onMount(() => {
    queueMicrotask(() => titleRef?.focus());
  });

  const derivedSlug = createMemo(() => slugify(title()));
  const effectiveSlug = (): string => slugOverride() ?? derivedSlug();

  const beginEditSlug = (): void => {
    setSlugOverride(slugOverride() ?? derivedSlug());
    setEditingSlug(true);
    queueMicrotask(() => slugRef?.focus());
  };

  const resetSlugToAuto = (): void => {
    setSlugOverride(null);
    setEditingSlug(false);
  };

  const validate = (): string | null => {
    if (!title().trim()) return 'Title is required.';
    const slug = effectiveSlug();
    if (!slug) return 'Slug is empty after normalisation — try a different title.';
    if (!isValidSlugTail(slug)) {
      return `Slug must match [a-z0-9-]+; got '${slug}'.`;
    }
    if (kind() === 'incident' && !severityImpact().trim()) {
      return 'Severity impact is required for incidents.';
    }
    return null;
  };

  const submit = async (): Promise<void> => {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setBusy(true);
    const input: ProjectCreateInput = {
      title: title().trim(),
      slug: effectiveSlug(),
      kind: kind(),
      status: status(),
    };
    if (kind() === 'incident') {
      input.environment = environment();
      input.severity = severity();
      input.severityImpact = severityImpact().trim();
    }
    try {
      const result = await window.condash.createProject(input);
      props.onCreated(result);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      class="new-project-modal"
      title="New project"
      onClose={requestClose}
      closeTitle="Cancel (Esc)"
      closeLabel="Cancel"
    >
      <div class="new-project-body">
        <label class="new-project-field">
          <span class="new-project-label">Title</span>
          <input
            ref={(el) => (titleRef = el)}
            class="new-project-input"
            type="text"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy()) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="What this project will achieve"
            disabled={busy()}
          />
        </label>

        <div class="new-project-field">
          <span class="new-project-label">Slug</span>
          <Show
            when={editingSlug()}
            fallback={
              <div class="new-project-slug-preview">
                <code class="new-project-slug-code">
                  {derivedSlug() || <span class="new-project-slug-empty">(empty)</span>}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="new-project-slug-edit"
                  onClick={beginEditSlug}
                  disabled={busy() || !derivedSlug()}
                >
                  edit
                </Button>
              </div>
            }
          >
            <div class="new-project-slug-edit-row">
              <input
                ref={(el) => (slugRef = el)}
                class="new-project-input new-project-slug-input"
                type="text"
                value={slugOverride() ?? ''}
                onInput={(e) => setSlugOverride(e.currentTarget.value)}
                disabled={busy()}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="new-project-slug-edit"
                onClick={resetSlugToAuto}
                disabled={busy()}
              >
                reset
              </Button>
            </div>
          </Show>
        </div>

        <div class="new-project-field">
          <span class="new-project-label">Kind</span>
          <div class="new-project-radio-group">
            <For each={KINDS}>
              {(k) => (
                <label class="new-project-radio">
                  <input
                    type="radio"
                    name="new-project-kind"
                    value={k}
                    checked={kind() === k}
                    onChange={() => setKind(k)}
                    disabled={busy()}
                  />
                  <span>{k}</span>
                </label>
              )}
            </For>
          </div>
        </div>

        <div class="new-project-field">
          <span class="new-project-label">Status</span>
          <div class="new-project-radio-group">
            <For each={STATUSES}>
              {(s) => (
                <label class="new-project-radio">
                  <input
                    type="radio"
                    name="new-project-status"
                    value={s}
                    checked={status() === s}
                    onChange={() => setStatus(s)}
                    disabled={busy()}
                  />
                  <span>{s}</span>
                </label>
              )}
            </For>
          </div>
        </div>

        <Show when={kind() === 'incident'}>
          <div class="new-project-field">
            <span class="new-project-label">Environment</span>
            <div class="new-project-radio-group">
              <For each={ENVIRONMENTS}>
                {(e) => (
                  <label class="new-project-radio">
                    <input
                      type="radio"
                      name="new-project-env"
                      value={e}
                      checked={environment() === e}
                      onChange={() => setEnvironment(e)}
                      disabled={busy()}
                    />
                    <span>{e}</span>
                  </label>
                )}
              </For>
            </div>
          </div>

          <div class="new-project-field">
            <span class="new-project-label">Severity</span>
            <div class="new-project-radio-group">
              <For each={SEVERITIES}>
                {(s) => (
                  <label class="new-project-radio">
                    <input
                      type="radio"
                      name="new-project-severity"
                      value={s}
                      checked={severity() === s}
                      onChange={() => setSeverity(s)}
                      disabled={busy()}
                    />
                    <span>{s}</span>
                  </label>
                )}
              </For>
            </div>
          </div>

          <label class="new-project-field">
            <span class="new-project-label">Severity impact</span>
            <input
              class="new-project-input"
              type="text"
              value={severityImpact()}
              onInput={(e) => setSeverityImpact(e.currentTarget.value)}
              placeholder="One-line user-facing impact"
              disabled={busy()}
            />
          </label>
        </Show>

        <Show when={error()}>
          <p class="new-project-error">{error()}</p>
        </Show>

        <ActionBar class="new-project-actions">
          <Button variant="default" onClick={props.onClose} disabled={busy()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy() || !title().trim() || !effectiveSlug()}
          >
            {busy() ? 'Creating…' : 'Create'}
          </Button>
        </ActionBar>
      </div>
    </Modal>
  );
}
