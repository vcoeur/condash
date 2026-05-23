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
  /** Open `<conception>/agents/.env` in the OS default editor. */
  onEditTokens: () => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [preview, setPreview] = createSignal<{ name: string; spec: AgentSpawnPreview } | null>(
    null,
  );

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
          <button type="button" onClick={props.onEditTokens} disabled={!props.hasConception()}>
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
                          <span class="agents-row-name">{agent.name}</span>
                          <TokenBadge agent={agent} />
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
            onInput={(e) => props.patch({ kimi: { agentFile: e.currentTarget.value } })}
          />
        </label>
      </Show>

      <Show when={d().harness === 'opencode'}>
        <label>
          <span>Model (--model provider/model)</span>
          <input
            type="text"
            value={d().opencode.model}
            onInput={(e) =>
              props.patch({ opencode: { ...d().opencode, model: e.currentTarget.value } })
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
