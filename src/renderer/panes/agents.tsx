import { createSignal, For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import {
  type AgentDef,
  type AgentListItem,
  type AgentSpawnPreview,
  type ClaudeAgentConfig,
  type HarnessId,
  type KimiAgentConfig,
  type OpencodeAgentConfig,
  type OpencodeReasoningOverride,
  buildSpawn,
  CLAUDE_PRESETS,
  defaultKimiConfig,
  defaultOpencodeConfig,
  HARNESS_IDS,
  HARNESSES,
  isValidSlug,
  OPENCODE_AGENT_NAMES,
  OPENCODE_PRESETS,
  OPENCODE_REASONING_EFFORTS,
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
  /** True once the user hand-edits the slug field, or always when editing an
   *  existing agent — suppresses further auto-suggestion. */
  slugTouched: boolean;
  secretEnv: string;
  claude: ClaudeAgentConfig;
  kimi: KimiAgentConfig;
  opencode: OpencodeAgentConfig;
  /** Slug of the agent being edited, or null when creating. The slug is the
   *  stable identity, so it is read-only while editing. */
  editingSlug: string | null;
}

function blankDraft(): Draft {
  return {
    harness: 'claude',
    name: 'deepseek-v4-pro',
    slug: suggestSlug('claude', 'deepseek-v4-pro'),
    slugTouched: false,
    secretEnv: CLAUDE_PRESETS['deepseek-v4-pro'].secretEnv,
    claude: structuredClone(CLAUDE_PRESETS['deepseek-v4-pro'].config),
    kimi: defaultKimiConfig(),
    opencode: defaultOpencodeConfig('deepseek/deepseek-v4-pro'),
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
    d.slugTouched = true; // slug is the stable identity — frozen while editing
    d.secretEnv = def.secretEnv ?? '';
    d.editingSlug = slug;
    if (def.harness === 'claude') d.claude = def.config;
    else if (def.harness === 'kimi') d.kimi = def.config;
    else d.opencode = def.config;
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
      const slug = await window.condash.writeAgent(buildDef(d), d.editingSlug ?? undefined);
      props.flashToast(`Saved ${slug}`, 'success');
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
              No agents yet. An agent is a harness (claude / kimi-cli / opencode) plus a model and
              an API token. Click <strong>+ New agent</strong> to define one.
            </p>
          }
        >
          <For each={HARNESS_IDS}>
            {(h) => (
              <Show when={grouped(h).length > 0}>
                <section class="agents-group">
                  <h3>{HARNESSES[h].label}</h3>
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

  // --- opencode per-agent reasoning-effort overrides ---
  const overrides = (): OpencodeReasoningOverride[] => d().opencode.reasoningOverrides ?? [];
  const usedAgents = () => new Set(overrides().map((o) => o.agent));
  /** Agent names selectable for a row: the unused built-ins, plus the row's own
   *  current value so it stays selected. */
  const agentOptions = (current: string) =>
    OPENCODE_AGENT_NAMES.filter((n) => n === current || !usedAgents().has(n));
  const availableAgents = () => OPENCODE_AGENT_NAMES.filter((n) => !usedAgents().has(n));
  const setOverrides = (next: OpencodeReasoningOverride[]) =>
    props.patch({
      opencode: { ...d().opencode, reasoningOverrides: next.length > 0 ? next : undefined },
    });
  const addOverride = () => {
    const agent = availableAgents()[0];
    if (!agent) return;
    setOverrides([...overrides(), { agent, effort: 'medium' }]);
  };
  const patchOverride = (idx: number, p: Partial<OpencodeReasoningOverride>) =>
    setOverrides(overrides().map((o, i) => (i === idx ? { ...o, ...p } : o)));
  const removeOverride = (idx: number) => setOverrides(overrides().filter((_, i) => i !== idx));

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
    // Reset the display name + secret to the harness's natural default when the
    // user switches harness mid-edit, and re-suggest the slug to match.
    const name = h === 'kimi' ? 'native' : 'deepseek-v4-pro';
    const secretEnv = h === 'claude' ? CLAUDE_PRESETS['deepseek-v4-pro'].secretEnv : '';
    props.patch({ harness: h, name, secretEnv, ...reslug(name, h) });
  };

  const applyPreset = (key: string) => {
    const preset = CLAUDE_PRESETS[key];
    if (!preset) return;
    props.patch({
      name: key,
      secretEnv: preset.secretEnv,
      claude: structuredClone(preset.config),
      ...reslug(key, 'claude'),
    });
  };

  const applyOpencodePreset = (key: string) => {
    const preset = OPENCODE_PRESETS[key];
    if (!preset) return;
    props.patch({
      name: key,
      secretEnv: preset.secretEnv,
      opencode: structuredClone(preset.config),
      ...reslug(key, 'opencode'),
    });
  };

  return (
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

      <Show when={d().harness === 'claude'}>
        <label>
          <span>Preset</span>
          <select onChange={(e) => applyPreset(e.currentTarget.value)}>
            <option value="">(custom)</option>
            <For each={Object.keys(CLAUDE_PRESETS)}>
              {(k) => (
                <option value={k} selected={k === d().name}>
                  {k}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>

      <label>
        <span>Name (display label)</span>
        <input type="text" value={d().name} onInput={(e) => onNameInput(e.currentTarget.value)} />
      </label>

      <label>
        <span>Slug (filename + identity)</span>
        <input
          type="text"
          value={d().slug}
          disabled={d().editingSlug !== null}
          title={
            d().editingSlug !== null
              ? 'The slug is the stable identity and cannot change after creation'
              : 'Lowercase letters, digits, and single hyphens'
          }
          onInput={(e) => onSlugInput(e.currentTarget.value)}
        />
      </label>

      <p class="agents-editor-name">
        File: <code>agents/{d().slug || '…'}.json</code>
      </p>

      <label>
        <span>Token env var (in agents/.env)</span>
        <input
          type="text"
          placeholder="DEEPSEEK_API_KEY (blank = no token)"
          value={d().secretEnv}
          onInput={(e) => props.patch({ secretEnv: e.currentTarget.value })}
        />
      </label>

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
          <code>--agent-file</code> (kimi's <code>ROLE_ADDITIONAL</code>) — so it's not shown in the
          command preview below. <code>condash skills install</code> writes{' '}
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
            value={d().kimi.thinking === undefined ? 'default' : d().kimi.thinking ? 'on' : 'off'}
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
        <label>
          <span>Preset</span>
          <select onChange={(e) => applyOpencodePreset(e.currentTarget.value)}>
            <option value="">(custom)</option>
            <For each={Object.keys(OPENCODE_PRESETS)}>
              {(k) => (
                <option value={k} selected={k === d().name}>
                  {k}
                </option>
              )}
            </For>
          </select>
        </label>
        <label>
          <span>Default model (provider/model)</span>
          <input
            type="text"
            value={d().opencode.model}
            onInput={(e) =>
              props.patch({ opencode: { ...d().opencode, model: e.currentTarget.value } })
            }
          />
        </label>
        <label>
          <span>Build agent model (optional override)</span>
          <input
            type="text"
            placeholder="inherit default"
            value={d().opencode.buildModel ?? ''}
            onInput={(e) =>
              props.patch({
                opencode: { ...d().opencode, buildModel: e.currentTarget.value || undefined },
              })
            }
          />
        </label>
        <label>
          <span>Plan agent model (optional override)</span>
          <input
            type="text"
            placeholder="inherit default"
            value={d().opencode.planModel ?? ''}
            onInput={(e) =>
              props.patch({
                opencode: { ...d().opencode, planModel: e.currentTarget.value || undefined },
              })
            }
          />
        </label>
        <label>
          <span>Default reasoning effort (options.reasoningEffort)</span>
          <select
            value={d().opencode.effortLevel ?? ''}
            onChange={(e) =>
              props.patch({
                opencode: { ...d().opencode, effortLevel: e.currentTarget.value || undefined },
              })
            }
          >
            <option value="">(model default)</option>
            <For each={effortOptions(d().opencode.effortLevel)}>
              {(v) => <option value={v}>{v}</option>}
            </For>
          </select>
        </label>
        <div class="agents-overrides">
          <span class="agents-overrides-label">Per-agent effort overrides</span>
          <For each={overrides()}>
            {(ov, i) => (
              <div class="agents-override-row">
                <select
                  value={ov.agent}
                  onChange={(e) => patchOverride(i(), { agent: e.currentTarget.value })}
                >
                  <For each={agentOptions(ov.agent)}>{(n) => <option value={n}>{n}</option>}</For>
                </select>
                <select
                  value={ov.effort}
                  onChange={(e) => patchOverride(i(), { effort: e.currentTarget.value })}
                >
                  <For each={effortOptions(ov.effort)}>{(v) => <option value={v}>{v}</option>}</For>
                </select>
                <button
                  type="button"
                  class="agents-danger agents-override-remove"
                  title="Remove this override"
                  onClick={() => removeOverride(i())}
                >
                  ×
                </button>
              </div>
            )}
          </For>
          <button type="button" onClick={addOverride} disabled={availableAgents().length === 0}>
            + Add override
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
                opencode: { ...d().opencode, extraConfigJson: e.currentTarget.value || undefined },
              })
            }
          />
        </label>
        <p class="agents-editor-note">
          condash inlines this as <code>OPENCODE_CONFIG_CONTENT</code> (no{' '}
          <code>opencode.json</code> needed): top-level <code>model</code> is the default;
          build/plan overrides become <code>agent.build.model</code> / <code>agent.plan.model</code>
          . The default effort sets <code>options.reasoningEffort</code> on each model; each
          per-agent override sets <code>agent.&lt;name&gt;.options.reasoningEffort</code>. Extra
          JSON is merged underneath. Auth via <code>opencode auth login</code> — leave the token
          field blank unless your provider reads a key from the environment (a stray key can collide
          with opencode's OAuth).
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
  );
}
