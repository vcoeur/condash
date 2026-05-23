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
  agentName,
  buildSpawn,
  CLAUDE_PRESETS,
  defaultKimiConfig,
  defaultOpencodeConfig,
  HARNESS_IDS,
  HARNESSES,
} from '@shared/harnesses';
import './agents-pane.css';

/** Editor draft. Holds every harness's config so switching harness in the form
 *  doesn't lose what the user typed for the others; `buildDef` reads only the
 *  active harness's slice. */
interface Draft {
  harness: HarnessId;
  modelVariant: string;
  secretEnv: string;
  claude: ClaudeAgentConfig;
  kimi: KimiAgentConfig;
  opencode: OpencodeAgentConfig;
  /** Name of the agent being edited, or null when creating. */
  editingName: string | null;
}

function blankDraft(): Draft {
  return {
    harness: 'claude',
    modelVariant: 'deepseek-v4-pro',
    secretEnv: CLAUDE_PRESETS['deepseek-v4-pro'].secretEnv,
    claude: structuredClone(CLAUDE_PRESETS['deepseek-v4-pro'].config),
    kimi: defaultKimiConfig(),
    opencode: defaultOpencodeConfig('deepseek/deepseek-v4-pro'),
    editingName: null,
  };
}

function buildDef(d: Draft): AgentDef {
  const base = { modelVariant: d.modelVariant.trim(), secretEnv: d.secretEnv.trim() || undefined };
  if (d.harness === 'kimi') return { harness: 'kimi', ...base, config: d.kimi };
  if (d.harness === 'opencode') return { harness: 'opencode', ...base, config: d.opencode };
  return { harness: 'claude', ...base, config: d.claude };
}

/**
 * Agents pane. Lists the agents defined under `<conception>/agents/`, grouped
 * by harness, and drives create / edit / delete plus per-agent launch. Each
 * agent is `<harness>-<model_variant>` — a harness (claude / kimi-cli /
 * opencode) plus a harness-specific config and an optional API token resolved
 * from the gitignored `agents/.env`.
 */
export function AgentsView(props: {
  /** Current agent list (token presence only, never values). */
  agents: () => readonly AgentListItem[];
  /** Re-fetch the agent list after a mutation. */
  reload: () => void;
  /** Whether a conception is active (agents are conception-scoped). */
  hasConception: () => boolean;
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
  /** Spawn a terminal tab running the named agent. */
  onLaunch: (name: string) => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [preview, setPreview] = createSignal<{ name: string; spec: AgentSpawnPreview } | null>(
    null,
  );
  // In-app agents/.env editor: null = closed; string = open with that content.
  const [tokens, setTokens] = createSignal<string | null>(null);

  const openTokens = async () => {
    setDraft(null);
    setPreview(null);
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
    setPreview(null);
    setDraft(blankDraft());
  };

  const startEdit = async (name: string) => {
    setPreview(null);
    const def = await window.condash.readAgent(name);
    if (!def) {
      props.flashToast(`Agent ${name} not found`, 'error');
      return;
    }
    const d = blankDraft();
    d.harness = def.harness;
    d.modelVariant = def.modelVariant;
    d.secretEnv = def.secretEnv ?? '';
    d.editingName = name;
    if (def.harness === 'claude') d.claude = def.config;
    else if (def.harness === 'kimi') d.kimi = def.config;
    else d.opencode = def.config;
    setDraft(d);
  };

  const save = async () => {
    const d = draft();
    if (!d) return;
    if (!d.modelVariant.trim()) {
      props.flashToast('Model variant is required', 'error');
      return;
    }
    try {
      const name = await window.condash.writeAgent(buildDef(d), d.editingName ?? undefined);
      props.flashToast(`Saved ${name}`, 'success');
      setDraft(null);
      props.reload();
    } catch (err) {
      props.flashToast(`Save failed: ${(err as Error).message}`, 'error');
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Delete agent ${name}? The agents/.env token is left untouched.`)) return;
    try {
      await window.condash.deleteAgent(name);
      props.flashToast(`Deleted ${name}`, 'success');
      if (preview()?.name === name) setPreview(null);
      props.reload();
    } catch (err) {
      props.flashToast(`Delete failed: ${(err as Error).message}`, 'error');
    }
  };

  const viewConfig = async (name: string) => {
    const spec = await window.condash.previewAgent(name);
    if (spec) setPreview({ name, spec });
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
                      <div class="agents-row">
                        <div class="agents-row-main">
                          <div class="agents-row-top">
                            <span class="agents-row-name">{agent.name}</span>
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
                            onClick={() => props.onLaunch(agent.name)}
                          >
                            Launch
                          </button>
                          <button type="button" onClick={() => void viewConfig(agent.name)}>
                            Config
                          </button>
                          <button type="button" onClick={() => void startEdit(agent.name)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            class="agents-danger"
                            onClick={() => void remove(agent.name)}
                          >
                            Delete
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

      <Show when={preview()}>
        {(p) => (
          <section class="agents-config-view">
            <header>
              <h3>{p().name} — resolved spawn</h3>
              <button type="button" onClick={() => setPreview(null)}>
                Close
              </button>
            </header>
            <pre>{formatPreview(p().spec)}</pre>
          </section>
        )}
      </Show>

      <Show when={draft()}>
        {(d) => (
          <AgentEditor
            draft={d}
            patch={patch}
            patchClaude={patchClaude}
            onSave={save}
            onCancel={() => setDraft(null)}
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
  const lines = [`$ ${[spec.command, ...spec.args].join(' ')}`, ''];
  for (const [k, v] of Object.entries(spec.env)) lines.push(`export ${k}=${v}`);
  for (const k of spec.unsetEnv) lines.push(`unset ${k}`);
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

function AgentEditor(props: {
  draft: () => Draft;
  patch: (p: Partial<Draft>) => void;
  patchClaude: (p: Partial<ClaudeAgentConfig>) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  const d = props.draft;

  const selectHarness = (h: HarnessId) => {
    // Reset the variant + secret to the harness's natural default when the
    // user switches harness mid-edit.
    if (h === 'claude')
      props.patch({
        harness: h,
        modelVariant: 'deepseek-v4-pro',
        secretEnv: CLAUDE_PRESETS['deepseek-v4-pro'].secretEnv,
      });
    else if (h === 'kimi') props.patch({ harness: h, modelVariant: 'native', secretEnv: '' });
    else props.patch({ harness: h, modelVariant: 'deepseek-v4-pro', secretEnv: '' });
  };

  const applyPreset = (key: string) => {
    const preset = CLAUDE_PRESETS[key];
    if (!preset) return;
    props.patch({
      modelVariant: key,
      secretEnv: preset.secretEnv,
      claude: structuredClone(preset.config),
    });
  };

  return (
    <section class="agents-editor">
      <header>
        <h3>{d().editingName ? `Edit ${d().editingName}` : 'New agent'}</h3>
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
                <option value={k} selected={k === d().modelVariant}>
                  {k}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>

      <label>
        <span>Model variant</span>
        <input
          type="text"
          value={d().modelVariant}
          onInput={(e) => props.patch({ modelVariant: e.currentTarget.value })}
        />
      </label>

      <p class="agents-editor-name">
        Agent name: <code>{agentName(buildDef(d()))}</code>
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
          <span>Agent file (--agent-file)</span>
          <input
            type="text"
            value={d().kimi.agentFile}
            onInput={(e) =>
              props.patch({ kimi: { ...d().kimi, agentFile: e.currentTarget.value } })
            }
          />
        </label>
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
          . Extra JSON is merged underneath.
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
      </div>
    </section>
  );
}
