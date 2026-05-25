import { createSignal, For, Index, onCleanup, onMount, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import {
  type AgentDef,
  type AgentListItem,
  type AgentSpawnPreview,
  type AgentsconfAgentConfig,
  type ClaudeAgentConfig,
  type HarnessId,
  type KimiAgentConfig,
  type OpencodeAgentConfig,
  type OpencodeAgentOptions,
  type OpencodeAgentRow,
  buildSpawn,
  defaultAgentsconfConfig,
  defaultClaudeConfig,
  defaultKimiConfig,
  defaultOpencodeConfig,
  HARNESS_IDS,
  HARNESSES,
  isBuiltinOpencodeAgent,
  isBuiltinPrimaryOpencodeAgent,
  isValidSlug,
  OPENCODE_AGENT_NAMES,
  OPENCODE_REASONING_EFFORTS,
  OPENCODE_REASONING_SUMMARIES,
  OPENCODE_TEXT_VERBOSITIES,
  suggestSlug,
} from '@shared/harnesses';
import { ConfirmModal } from '../confirm-modal';
import './agents-pane.css';

/** Editor draft. Holds every harness's config so switching harness in the form
 *  doesn't lose what the user typed for the others; `buildDef` reads only the
 *  active harness's slice. */
interface Draft {
  harness: HarnessId;
  /** Free-form display name. */
  name: string;
  /** Lowercase-kebab identity = filename stem. Auto-suggested from `name` until
   *  the user edits it (`slugTouched`), then frozen once the agent is saved. */
  slug: string;
  /** True once the user hand-edits the slug field — suppresses name-driven
   *  auto-suggestion. Set on every edit of an existing agent so its stored slug
   *  is the starting point (the field stays editable: a change is a rename). */
  slugTouched: boolean;
  secretEnv: string;
  claude: ClaudeAgentConfig;
  kimi: KimiAgentConfig;
  opencode: OpencodeAgentConfig;
  agentsconf: AgentsconfAgentConfig;
  /** Slug of the agent being edited, or null when creating. A new slug saved
   *  over this renames the file (the old `<slug>.json` is removed). */
  editingSlug: string | null;
}

function blankDraft(): Draft {
  return {
    harness: 'claude',
    name: '',
    slug: '',
    slugTouched: false,
    secretEnv: '',
    claude: defaultClaudeConfig(),
    kimi: defaultKimiConfig(),
    opencode: defaultOpencodeConfig(''),
    agentsconf: defaultAgentsconfConfig(),
    editingSlug: null,
  };
}

function buildDef(d: Draft): AgentDef {
  const base = {
    name: d.name.trim(),
    slug: d.slug.trim(),
    secretEnv: d.secretEnv.trim() || undefined,
  };
  if (d.harness === 'kimi') return { harness: 'kimi', ...base, config: d.kimi };
  if (d.harness === 'opencode') return { harness: 'opencode', ...base, config: d.opencode };
  if (d.harness === 'agentsconf') return { harness: 'agentsconf', ...base, config: d.agentsconf };
  return { harness: 'claude', ...base, config: d.claude };
}

/**
 * Agents pane. Lists the agents defined under `<conception>/agents/`, grouped
 * by harness, and drives create / edit / delete plus per-agent launch. Each
 * agent is a harness (claude / kimi-cli / opencode) plus a free-form display
 * `name`, a stable lowercase-kebab `slug` (its filename + identity), a
 * harness-specific config, and an optional API token resolved from the
 * gitignored `agents/.env`.
 */
export function AgentsView(props: {
  /** Current agent list (token presence only, never values). */
  agents: () => readonly AgentListItem[];
  /** Re-fetch the agent list after a mutation. */
  reload: () => void;
  /** Re-fetch the task list — called after a slug rename cascades to tasks, so
   *  the Tasks pane reflects the repointed `agent` without a manual refresh. */
  reloadTasks: () => void;
  /** Whether a conception is active (agents are conception-scoped). */
  hasConception: () => boolean;
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
  /** Spawn a terminal tab running the agent with this slug. */
  onLaunch: (slug: string) => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal<Draft | null>(null);
  // In-app agents/.env editor: null = closed; string = open with that content.
  const [tokens, setTokens] = createSignal<string | null>(null);

  const openTokens = async () => {
    setDraft(null);
    setTokens((await window.condash.readAgentsEnv()) ?? '');
  };

  const saveTokens = async () => {
    const content = tokens();
    if (content === null) return;
    try {
      await window.condash.writeAgentsEnv(content);
      props.flashToast('Saved agents/.env', 'success');
      setTokens(null);
      props.reload(); // refresh token-presence badges
    } catch (err) {
      props.flashToast(`Save failed: ${(err as Error).message}`, 'error');
    }
  };

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const patchClaude = (p: Partial<ClaudeAgentConfig>) =>
    setDraft((d) => (d ? { ...d, claude: { ...d.claude, ...p } } : d));

  const startCreate = () => {
    setDraft(blankDraft());
  };

  const startEdit = async (slug: string) => {
    const def = await window.condash.readAgent(slug);
    if (!def) {
      props.flashToast(`Agent ${slug} not found`, 'error');
      return;
    }
    const d = blankDraft();
    d.harness = def.harness;
    d.name = def.name;
    d.slug = def.slug;
    d.slugTouched = true; // start from the stored slug; editing it renames the file
    d.secretEnv = def.secretEnv ?? '';
    d.editingSlug = slug;
    if (def.harness === 'claude') d.claude = def.config;
    else if (def.harness === 'kimi') d.kimi = def.config;
    else if (def.harness === 'opencode') d.opencode = def.config;
    else d.agentsconf = def.config;
    setDraft(d);
  };

  const save = async () => {
    const d = draft();
    if (!d) return;
    if (!d.name.trim()) {
      props.flashToast('Name is required', 'error');
      return;
    }
    if (!isValidSlug(d.slug.trim())) {
      props.flashToast('Slug must be lowercase letters, digits, and single hyphens', 'error');
      return;
    }
    try {
      const previousSlug = d.editingSlug ?? undefined;
      const slug = await window.condash.writeAgent(buildDef(d), previousSlug);
      // A slug change is a rename: repoint every task that referenced the old
      // slug so it keeps resolving (cascade). Best-effort after the agent write.
      let suffix = '';
      if (previousSlug && previousSlug !== slug) {
        const repointed = await window.condash.repointTasksAgent(previousSlug, slug);
        if (repointed > 0) {
          suffix = ` · repointed ${repointed} task${repointed === 1 ? '' : 's'}`;
          props.reloadTasks(); // the cascade rewrote task files — refresh that pane
        }
      }
      props.flashToast(`Saved ${slug}${suffix}`, 'success');
      setDraft(null);
      props.reload();
    } catch (err) {
      props.flashToast(`Save failed: ${(err as Error).message}`, 'error');
    }
  };

  // Delete the agent currently open in the editor. Confirmation is handled by
  // the editor's own ConfirmModal before this runs.
  const deleteEditing = async () => {
    const d = draft();
    if (!d?.editingSlug) return;
    try {
      await window.condash.deleteAgent(d.editingSlug);
      props.flashToast(`Deleted ${d.name}`, 'success');
      setDraft(null);
      props.reload();
    } catch (err) {
      props.flashToast(`Delete failed: ${(err as Error).message}`, 'error');
    }
  };

  const grouped = (h: HarnessId) => props.agents().filter((a) => a.harness === h);

  return (
    <div class="agents-pane">
      <header class="agents-pane-header">
        <h2>Agents</h2>
        <div class="agents-pane-actions">
          <button type="button" onClick={startCreate} disabled={!props.hasConception()}>
            + New agent
          </button>
          <button type="button" onClick={() => void openTokens()} disabled={!props.hasConception()}>
            Edit tokens (agents/.env)
          </button>
        </div>
      </header>

      <Show
        when={props.hasConception()}
        fallback={<p class="agents-pane-empty">Open a conception to manage its agents.</p>}
      >
        <Show
          when={props.agents().length > 0}
          fallback={
            <p class="agents-pane-empty">
              No agents yet. An agent is a harness (claude / kimi-cli / opencode / agentsconf) plus
              a model and an API token, or — for agentsconf — just a binary name. Click{' '}
              <strong>+ New agent</strong> to define one.
            </p>
          }
        >
          <For each={HARNESS_IDS}>
            {(h) => (
              <Show when={grouped(h).length > 0}>
                <section class="agents-group">
                  <h3>{HARNESSES[h].label}</h3>
                  <div class="agents-grid">
                    <For each={grouped(h)}>
                      {(agent) => (
                        <div
                          class="agents-row agents-row-clickable"
                          role="button"
                          tabindex={0}
                          title="Click to edit this agent"
                          onClick={() => void startEdit(agent.slug)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              void startEdit(agent.slug);
                            }
                          }}
                        >
                          <div class="agents-row-main">
                            <div class="agents-row-top">
                              <span class="agents-row-name">{agent.name}</span>
                              <code class="agents-row-slug" title="Slug (filename + identity)">
                                {agent.slug}
                              </code>
                              <TokenBadge agent={agent} />
                            </div>
                            <code class="agents-row-cmd" title="Command launched (token not shown)">
                              {agent.command}
                            </code>
                          </div>
                          <div class="agents-row-actions">
                            <button
                              type="button"
                              title="Open a tab running this agent"
                              onClick={(e) => {
                                e.stopPropagation();
                                props.onLaunch(agent.slug);
                              }}
                            >
                              Launch
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              </Show>
            )}
          </For>
        </Show>
      </Show>

      <Show when={tokens() !== null}>
        <section class="agents-editor agents-tokens-editor">
          <header>
            <h3>agents/.env — API tokens</h3>
          </header>
          <p class="agents-editor-note">
            One <code>NAME=value</code> per line; gitignored. Each agent names the variable it reads
            via its "Token env var" field — the value lives here.
          </p>
          <textarea
            class="agents-tokens-textarea"
            spellcheck={false}
            value={tokens() ?? ''}
            onInput={(e) => setTokens(e.currentTarget.value)}
          />
          <div class="agents-editor-actions">
            <button type="button" onClick={() => void saveTokens()}>
              Save
            </button>
            <button type="button" onClick={() => setTokens(null)}>
              Cancel
            </button>
          </div>
        </section>
      </Show>

      <Show when={draft()}>
        {(d) => (
          <AgentEditor
            draft={d}
            patch={patch}
            patchClaude={patchClaude}
            onSave={save}
            onCancel={() => setDraft(null)}
            onDelete={deleteEditing}
          />
        )}
      </Show>
    </div>
  );
}

function TokenBadge(props: { agent: AgentListItem }): JSX.Element {
  return (
    <Show
      when={props.agent.secretEnv}
      fallback={<span class="agents-token agents-token-none">no token</span>}
    >
      <Show
        when={props.agent.tokenPresent}
        fallback={
          <span
            class="agents-token agents-token-missing"
            title={`Set ${props.agent.secretEnv} in agents/.env`}
          >
            {props.agent.secretEnv} missing
          </span>
        }
      >
        <span class="agents-token agents-token-ok">{props.agent.secretEnv} set</span>
      </Show>
    </Show>
  );
}

function formatPreview(spec: AgentSpawnPreview): string {
  // Environment is set before the command runs, so list exports / unsets first.
  const lines: string[] = [];
  for (const [k, v] of Object.entries(spec.env)) lines.push(`export ${k}=${v}`);
  for (const k of spec.unsetEnv) lines.push(`unset ${k}`);
  if (lines.length > 0) lines.push('');
  lines.push(`$ ${[spec.command, ...spec.args].join(' ')}`);
  return lines.join('\n');
}

/** Live editor preview, guarded so a half-typed JSON field (opencode's extra
 *  config is parsed by buildSpawn) doesn't crash the render. */
function safePreview(d: Draft): string {
  try {
    return formatPreview(buildSpawn(buildDef(d), (k) => `$${k}`));
  } catch (err) {
    return `(cannot preview: ${(err as Error).message})`;
  }
}

/** Effort `<select>` values: the fixed list, plus a stored off-list value (e.g.
 *  a legacy `max`) prepended so it round-trips and stays selected. */
function effortOptions(current: string | undefined): readonly string[] {
  const fixed: readonly string[] = OPENCODE_REASONING_EFFORTS;
  if (current && !fixed.includes(current)) return [current, ...fixed];
  return fixed;
}

function AgentEditor(props: {
  draft: () => Draft;
  patch: (p: Partial<Draft>) => void;
  patchClaude: (p: Partial<ClaudeAgentConfig>) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}): JSX.Element {
  const d = props.draft;
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  // Esc closes the editor modal — but defer to the delete-confirm dialog when it
  // is open (its own handler closes it first).
  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !confirmDelete()) {
      event.preventDefault();
      props.onCancel();
    }
  };
  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));

  // --- opencode agent options table ---
  // Default row: top-level `model` + `defaultOptions` (applied to every agent).
  const defaultOptions = (): OpencodeAgentOptions => d().opencode.defaultOptions ?? {};
  const setDefaultModel = (model: string) => props.patch({ opencode: { ...d().opencode, model } });
  const patchDefaultOptions = (p: Partial<OpencodeAgentOptions>) => {
    const merged = { ...defaultOptions(), ...p };
    const clean: OpencodeAgentOptions = {};
    if (merged.reasoningEffort) clean.reasoningEffort = merged.reasoningEffort;
    if (merged.textVerbosity) clean.textVerbosity = merged.textVerbosity;
    if (merged.reasoningSummary) clean.reasoningSummary = merged.reasoningSummary;
    props.patch({
      opencode: {
        ...d().opencode,
        defaultOptions: Object.keys(clean).length > 0 ? clean : undefined,
      },
    });
  };

  // Per-agent rows.
  const agentRows = (): OpencodeAgentRow[] => d().opencode.agentOptions ?? [];
  const usedRowAgents = () => new Set(agentRows().map((r) => r.agent.trim()));
  // Built-in names not already used by another row — offered as datalist
  // suggestions; the field itself accepts any custom name.
  const rowAgentSuggestions = (current: string) =>
    OPENCODE_AGENT_NAMES.filter((n) => n === current || !usedRowAgents().has(n));
  const setAgentRows = (next: OpencodeAgentRow[]) =>
    props.patch({
      opencode: { ...d().opencode, agentOptions: next.length > 0 ? next : undefined },
    });
  // New rows start as a blank *custom* primary agent — typing a built-in name
  // turns the row into that built-in's override (its primary toggle auto-disables).
  const addAgentRow = () => setAgentRows([...agentRows(), { agent: '', primary: true }]);
  const patchAgentRow = (idx: number, p: Partial<OpencodeAgentRow>) =>
    setAgentRows(agentRows().map((r, i) => (i === idx ? { ...r, ...p } : r)));
  const removeAgentRow = (idx: number) => setAgentRows(agentRows().filter((_, i) => i !== idx));
  // Whether a row's "primary" toggle shows checked: built-ins reflect their fixed
  // opencode mode (build/plan primary); custom rows default to primary.
  const rowIsPrimary = (row: OpencodeAgentRow): boolean =>
    isBuiltinOpencodeAgent(row.agent.trim())
      ? isBuiltinPrimaryOpencodeAgent(row.agent.trim())
      : (row.primary ?? true);

  /** Re-suggest the slug from `name` under `harness`, unless the user has
   *  hand-edited the slug or is editing an existing agent (slug is frozen). */
  const reslug = (name: string, harness: HarnessId): Partial<Draft> =>
    d().editingSlug || d().slugTouched ? {} : { slug: suggestSlug(harness, name) };

  const onNameInput = (value: string) => {
    props.patch({ name: value, ...reslug(value, d().harness) });
  };

  const onSlugInput = (value: string) => {
    props.patch({ slug: value, slugTouched: true });
  };

  const selectHarness = (h: HarnessId) => {
    // Switch harness, keeping whatever the user typed; re-suggest the slug so its
    // harness-label prefix matches (skipped once the slug is hand-edited).
    props.patch({ harness: h, ...reslug(d().name, h) });
  };

  return (
    <div class="modal-backdrop" onClick={props.onCancel}>
      <div
        class="modal agents-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label={d().editingSlug ? `Edit ${d().editingSlug}` : 'New agent'}
        onClick={(e) => e.stopPropagation()}
      >
        <section class="agents-editor">
          <header>
            <h3>{d().editingSlug ? `Edit ${d().editingSlug}` : 'New agent'}</h3>
          </header>

          <label>
            <span>Harness</span>
            <select
              value={d().harness}
              onChange={(e) => selectHarness(e.currentTarget.value as HarnessId)}
            >
              <For each={HARNESS_IDS}>{(h) => <option value={h}>{HARNESSES[h].label}</option>}</For>
            </select>
          </label>

          <label>
            <span>Name (display label)</span>
            <input
              type="text"
              value={d().name}
              onInput={(e) => onNameInput(e.currentTarget.value)}
            />
          </label>

          <label>
            <span>Slug (filename + identity)</span>
            <input
              type="text"
              value={d().slug}
              title="Lowercase letters, digits, and single hyphens. Changing it renames the agent file and repoints referencing tasks."
              onInput={(e) => onSlugInput(e.currentTarget.value)}
            />
          </label>

          <p class="agents-editor-name">
            File: <code>agents/{d().slug || '…'}.json</code>
            <Show when={d().editingSlug && d().editingSlug !== d().slug.trim()}>
              {' '}
              <span class="agents-editor-rename">
                (renamed from <code>{d().editingSlug}</code>)
              </span>
            </Show>
          </p>

          <Show when={d().harness !== 'agentsconf'}>
            <label>
              <span>Token env var (in agents/.env)</span>
              <input
                type="text"
                placeholder="DEEPSEEK_API_KEY (blank = no token)"
                value={d().secretEnv}
                onInput={(e) => props.patch({ secretEnv: e.currentTarget.value })}
              />
            </label>
          </Show>

          <Show when={d().harness === 'agentsconf'}>
            <label>
              <span>Binary (on $PATH)</span>
              <input
                type="text"
                placeholder="claude-deepseek-auto"
                value={d().agentsconf.binary}
                onInput={(e) =>
                  props.patch({ agentsconf: { ...d().agentsconf, binary: e.currentTarget.value } })
                }
              />
            </label>
            <p class="agents-editor-note">
              condash runs this binary as-is — <code>&lt;binary&gt;</code> for a terminal,{' '}
              <code>&lt;binary&gt; --run "PROMPT"</code> for a task. The binary (shipped by
              agentsconf) owns the model, env, instructions, and skills; condash sets nothing else
              and resolves no token.
            </p>
          </Show>

          <Show when={d().harness === 'kimi'}>
            <label>
              <span>Instructions file (injected as system prompt)</span>
              <input
                type="text"
                placeholder="~/.kimi/AGENTS.md (blank = none)"
                value={d().kimi.instructionsFile ?? ''}
                onInput={(e) =>
                  props.patch({
                    kimi: { ...d().kimi, instructionsFile: e.currentTarget.value || undefined },
                  })
                }
              />
            </label>
            <p class="agents-editor-note">
              condash reads this plain markdown at launch and wraps it into a transient{' '}
              <code>--agent-file</code> (kimi's <code>ROLE_ADDITIONAL</code>) — so it's not shown in
              the command preview below. <code>condash skills install</code> writes{' '}
              <code>~/.kimi/AGENTS.md</code>.
            </p>
            <label>
              <span>Model (--model, blank = config default)</span>
              <input
                type="text"
                value={d().kimi.model ?? ''}
                onInput={(e) =>
                  props.patch({ kimi: { ...d().kimi, model: e.currentTarget.value || undefined } })
                }
              />
            </label>
            <label>
              <span>Thinking mode</span>
              <select
                value={
                  d().kimi.thinking === undefined ? 'default' : d().kimi.thinking ? 'on' : 'off'
                }
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  props.patch({
                    kimi: { ...d().kimi, thinking: v === 'default' ? undefined : v === 'on' },
                  });
                }}
              >
                <option value="default">config default</option>
                <option value="on">--thinking</option>
                <option value="off">--no-thinking</option>
              </select>
            </label>
            <label class="agents-checkbox">
              <input
                type="checkbox"
                checked={d().kimi.plan ?? false}
                onChange={(e) =>
                  props.patch({ kimi: { ...d().kimi, plan: e.currentTarget.checked || undefined } })
                }
              />
              <span>Start in plan mode (--plan)</span>
            </label>
            <label>
              <span>Inline config (--config TOML/JSON, optional)</span>
              <textarea
                class="agents-config-textarea"
                spellcheck={false}
                value={d().kimi.configInline ?? ''}
                onInput={(e) =>
                  props.patch({
                    kimi: { ...d().kimi, configInline: e.currentTarget.value || undefined },
                  })
                }
              />
            </label>
          </Show>

          <Show when={d().harness === 'opencode'}>
            <div class="agents-overrides agents-options-table">
              <span class="agents-overrides-label">
                Per-agent reasoning — the <code>default</code> row applies to every agent; add rows
                to override the model and/or options for a specific agent. Type a custom agent name
                and mark it <code>primary</code> to add a new switchable agent (Tab) beyond{' '}
                <code>build</code>/<code>plan</code>. Built-in agents keep their fixed mode.
              </span>
              <div class="agents-option-row agents-option-head">
                <span>agent</span>
                <span>primary</span>
                <span>model</span>
                <span>effort</span>
                <span>verbosity</span>
                <span>summary</span>
                <span />
              </div>
              <div class="agents-option-row">
                <span class="agents-option-default">(default)</span>
                <span />
                <input
                  type="text"
                  placeholder="provider/model"
                  value={d().opencode.model}
                  onInput={(e) => setDefaultModel(e.currentTarget.value)}
                />
                <select
                  title="reasoningEffort"
                  value={defaultOptions().reasoningEffort ?? ''}
                  onChange={(e) =>
                    patchDefaultOptions({ reasoningEffort: e.currentTarget.value || undefined })
                  }
                >
                  <option value="">effort —</option>
                  <For each={effortOptions(defaultOptions().reasoningEffort)}>
                    {(x) => <option value={x}>{x}</option>}
                  </For>
                </select>
                <select
                  title="textVerbosity"
                  value={defaultOptions().textVerbosity ?? ''}
                  onChange={(e) =>
                    patchDefaultOptions({ textVerbosity: e.currentTarget.value || undefined })
                  }
                >
                  <option value="">verbosity —</option>
                  <For each={OPENCODE_TEXT_VERBOSITIES}>
                    {(x) => <option value={x}>{x}</option>}
                  </For>
                </select>
                <select
                  title="reasoningSummary"
                  value={defaultOptions().reasoningSummary ?? ''}
                  onChange={(e) =>
                    patchDefaultOptions({ reasoningSummary: e.currentTarget.value || undefined })
                  }
                >
                  <option value="">summary —</option>
                  <For each={OPENCODE_REASONING_SUMMARIES}>
                    {(x) => <option value={x}>{x}</option>}
                  </For>
                </select>
                <span />
              </div>
              <Index each={agentRows()}>
                {(r, i) => (
                  <div class="agents-option-row">
                    <input
                      type="text"
                      class="agents-option-agent"
                      placeholder="agent name"
                      list={`oc-agent-names-${i}`}
                      value={r().agent}
                      onInput={(e) => patchAgentRow(i, { agent: e.currentTarget.value })}
                    />
                    <datalist id={`oc-agent-names-${i}`}>
                      <For each={rowAgentSuggestions(r().agent)}>{(n) => <option value={n} />}</For>
                    </datalist>
                    <label
                      class="agents-option-primary"
                      title={
                        isBuiltinOpencodeAgent(r().agent.trim())
                          ? `Built-in ${isBuiltinPrimaryOpencodeAgent(r().agent.trim()) ? 'primary' : 'subagent'} — mode fixed by opencode`
                          : 'Switchable primary agent (emits mode: "primary")'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={rowIsPrimary(r())}
                        disabled={isBuiltinOpencodeAgent(r().agent.trim())}
                        onChange={(e) => patchAgentRow(i, { primary: e.currentTarget.checked })}
                      />
                    </label>
                    <input
                      type="text"
                      placeholder="inherit default"
                      value={r().model ?? ''}
                      onInput={(e) =>
                        patchAgentRow(i, { model: e.currentTarget.value || undefined })
                      }
                    />
                    <select
                      title="reasoningEffort"
                      value={r().reasoningEffort ?? ''}
                      onChange={(e) =>
                        patchAgentRow(i, { reasoningEffort: e.currentTarget.value || undefined })
                      }
                    >
                      <option value="">effort —</option>
                      <For each={effortOptions(r().reasoningEffort)}>
                        {(x) => <option value={x}>{x}</option>}
                      </For>
                    </select>
                    <select
                      title="textVerbosity"
                      value={r().textVerbosity ?? ''}
                      onChange={(e) =>
                        patchAgentRow(i, { textVerbosity: e.currentTarget.value || undefined })
                      }
                    >
                      <option value="">verbosity —</option>
                      <For each={OPENCODE_TEXT_VERBOSITIES}>
                        {(x) => <option value={x}>{x}</option>}
                      </For>
                    </select>
                    <select
                      title="reasoningSummary"
                      value={r().reasoningSummary ?? ''}
                      onChange={(e) =>
                        patchAgentRow(i, { reasoningSummary: e.currentTarget.value || undefined })
                      }
                    >
                      <option value="">summary —</option>
                      <For each={OPENCODE_REASONING_SUMMARIES}>
                        {(x) => <option value={x}>{x}</option>}
                      </For>
                    </select>
                    <button
                      type="button"
                      class="agents-danger agents-override-remove"
                      title="Remove this agent row"
                      onClick={() => removeAgentRow(i)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </Index>
              <button type="button" onClick={addAgentRow}>
                + Add agent
              </button>
            </div>
            <label class="agents-checkbox">
              <input
                type="checkbox"
                checked={d().opencode.disableExternalSkills}
                onChange={(e) =>
                  props.patch({
                    opencode: { ...d().opencode, disableExternalSkills: e.currentTarget.checked },
                  })
                }
              />
              <span>Disable external skills (OPENCODE_DISABLE_EXTERNAL_SKILLS)</span>
            </label>
            <label>
              <span>Extra config (JSON merged into OPENCODE_CONFIG_CONTENT)</span>
              <textarea
                class="agents-config-textarea"
                spellcheck={false}
                placeholder={'{ "theme": "…", "provider": { … } }'}
                value={d().opencode.extraConfigJson ?? ''}
                onInput={(e) =>
                  props.patch({
                    opencode: {
                      ...d().opencode,
                      extraConfigJson: e.currentTarget.value || undefined,
                    },
                  })
                }
              />
            </label>
            <p class="agents-editor-note">
              condash inlines this as <code>OPENCODE_CONFIG_CONTENT</code> (no{' '}
              <code>opencode.json</code> needed). The <code>default</code> row's model is top-level{' '}
              <code>model</code> and its options become that model's base <code>options</code>{' '}
              (inherited by every agent on it); each per-agent row sets{' '}
              <code>agent.&lt;name&gt;.options</code> (applied to its requests) plus{' '}
              <code>agent.&lt;name&gt;.model</code> when it overrides the model, and{' '}
              <code>agent.&lt;name&gt;.mode = "primary"</code> for a custom row marked primary.
              Extra JSON is merged underneath. Auth via <code>opencode auth login</code> — leave the
              token field blank unless your provider reads a key from the environment (a stray key
              can collide with opencode's OAuth).
            </p>
          </Show>

          <Show when={d().harness === 'claude'}>
            <details class="agents-advanced">
              <summary>Advanced claude config</summary>
              <label>
                <span>Base URL</span>
                <input
                  type="text"
                  value={d().claude.baseUrl}
                  onInput={(e) => props.patchClaude({ baseUrl: e.currentTarget.value })}
                />
              </label>
              <label>
                <span>Auth style</span>
                <select
                  value={d().claude.authStyle}
                  onChange={(e) =>
                    props.patchClaude({ authStyle: e.currentTarget.value as 'bearer' | 'apikey' })
                  }
                >
                  <option value="bearer">bearer (ANTHROPIC_AUTH_TOKEN)</option>
                  <option value="apikey">apikey (ANTHROPIC_API_KEY)</option>
                </select>
              </label>
              <For
                each={
                  [
                    ['model', 'Main model'],
                    ['smallFastModel', 'Small/fast model'],
                    ['haikuAlias', 'haiku alias'],
                    ['sonnetAlias', 'sonnet alias'],
                    ['opusAlias', 'opus alias'],
                    ['subagentModel', 'Subagent model'],
                    ['effortLevel', 'Effort level (CLAUDE_CODE_EFFORT_LEVEL)'],
                  ] as [keyof ClaudeAgentConfig, string][]
                }
              >
                {([key, label]) => (
                  <label>
                    <span>{label}</span>
                    <input
                      type="text"
                      value={String(d().claude[key])}
                      onInput={(e) =>
                        props.patchClaude({
                          [key]: e.currentTarget.value,
                        } as Partial<ClaudeAgentConfig>)
                      }
                    />
                  </label>
                )}
              </For>
              <label>
                <span>Max context tokens</span>
                <input
                  type="number"
                  value={d().claude.maxContextTokens}
                  onInput={(e) =>
                    props.patchClaude({ maxContextTokens: Number(e.currentTarget.value) || 0 })
                  }
                />
              </label>
              <For
                each={
                  [
                    ['disableCaching', 'Disable prompt caching'],
                    ['disable1M', 'Disable 1M context'],
                    ['disableAdaptiveThinking', 'Disable adaptive thinking'],
                    ['disableTelemetry', 'Disable telemetry'],
                    ['disableErrorReporting', 'Disable error reporting'],
                    ['disableClaudeApiSkill', 'Hide /claude-api skill'],
                  ] as [keyof ClaudeAgentConfig, string][]
                }
              >
                {([key, label]) => (
                  <label class="agents-checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(d().claude[key])}
                      onChange={(e) =>
                        props.patchClaude({
                          [key]: e.currentTarget.checked,
                        } as Partial<ClaudeAgentConfig>)
                      }
                    />
                    <span>{label}</span>
                  </label>
                )}
              </For>
            </details>
          </Show>

          <div class="agents-config-view agents-editor-preview">
            <span class="agents-editor-preview-label">Will launch (as configured):</span>
            <pre>{safePreview(d())}</pre>
          </div>

          <div class="agents-editor-actions">
            <button type="button" onClick={props.onSave}>
              Save
            </button>
            <button type="button" onClick={props.onCancel}>
              Cancel
            </button>
            <Show when={d().editingSlug}>
              <button
                type="button"
                class="agents-danger agents-editor-delete"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            </Show>
          </div>

          <Show when={confirmDelete()}>
            <ConfirmModal
              title={`Delete agent ${d().name}?`}
              body="Removes the agent definition file. The agents/.env token is left untouched."
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
