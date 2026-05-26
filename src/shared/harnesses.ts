/**
 * Unified harness registry — the single source of truth for the agent CLIs
 * condash supports (claude, kimi-cli, opencode, agentsconf).
 *
 * A *harness* is the unit that carries every per-CLI launch specific. An
 * *agent* is `<harness>-<model_variant>` (a harness + a harness-specific config
 * + an optional API token). The `buildSpawn` adapter below knows the *correct*
 * invocation to run each agent: claude exports `ANTHROPIC_*` env, kimi-cli
 * points at its `--agent-file` YAML, opencode passes `--model`, and
 * `agentsconf` simply runs a named binary that owns its own config.
 *
 * condash no longer compiles per-harness skills / AGENTS.md outputs — it ships
 * the agent-neutral source (`.agents/skills/`, `AGENTS.md`) and the harness
 * launcher renders per agent at run time. So this registry is purely about
 * launch; there is no compile-target subset.
 *
 * Pure module — no Node / zod imports — so main, renderer, and the CLI bundle
 * can all import it. Runtime validation of the on-disk JSON lives in the main
 * loader (`src/main/agents/`).
 */

/** Canonical harness id. `claude` / `kimi` / `opencode` match the on-disk config
 *  dirs (`.claude/`, `.kimi/`, `.opencode/`); `agentsconf` runs a named binary
 *  that owns its own config. */
export type HarnessId = 'claude' | 'kimi' | 'opencode' | 'agentsconf';

export const HARNESS_IDS: readonly HarnessId[] = [
  'claude',
  'kimi',
  'opencode',
  'agentsconf',
] as const;

/** Per-harness identity used to build the launch command. */
export interface HarnessMeta {
  id: HarnessId;
  /** User-facing label — the CLI's own product name (kimi's CLI is "kimi-cli"). */
  label: string;
  /** Executable spawned on `$PATH`. Note kimi-cli's binary is `kimi`. Empty for
   *  `agentsconf`, whose binary comes per-agent from `AgentsconfAgentConfig.binary`. */
  binary: string;
}

export const HARNESSES: Record<HarnessId, HarnessMeta> = {
  claude: {
    id: 'claude',
    label: 'claude',
    binary: 'claude',
  },
  kimi: {
    id: 'kimi',
    label: 'kimi-cli',
    binary: 'kimi',
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    binary: 'opencode',
  },
  agentsconf: {
    id: 'agentsconf',
    label: 'agentsconf',
    // No fixed binary — each agent names its own (config.binary).
    binary: '',
  },
};

export function isHarnessId(value: unknown): value is HarnessId {
  return value === 'claude' || value === 'kimi' || value === 'opencode' || value === 'agentsconf';
}

// ---------------------------------------------------------------------------
// Per-harness configuration shapes
// ---------------------------------------------------------------------------

export type ClaudeAuthStyle = 'bearer' | 'apikey';

/**
 * claude harness config. Reproduces the knobs of the agentsconf
 * `claude-<provider>` wrappers so condash can build the same `ANTHROPIC_*`
 * environment in-process instead of shelling a generated wrapper.
 */
export interface ClaudeAgentConfig {
  /** `ANTHROPIC_BASE_URL` — the Anthropic-compatible endpoint. */
  baseUrl: string;
  /** `bearer` → `ANTHROPIC_AUTH_TOKEN`; `apikey` → `ANTHROPIC_API_KEY`. */
  authStyle: ClaudeAuthStyle;
  model: string;
  smallFastModel: string;
  haikuAlias: string;
  sonnetAlias: string;
  opusAlias: string;
  subagentModel: string;
  maxContextTokens: number;
  /** `CLAUDE_CODE_EFFORT_LEVEL` — reasoning-effort level handed to the harness
   *  (e.g. `max` for alt-providers that map it onto their reasoning budget).
   *  Blank = omit the var so the session's own `/effort` drives it. */
  effortLevel: string;
  disableCaching: boolean;
  disable1M: boolean;
  disableAdaptiveThinking: boolean;
  disableTelemetry: boolean;
  disableErrorReporting: boolean;
  disableClaudeApiSkill: boolean;
}

/** kimi-cli harness config. */
export interface KimiAgentConfig {
  /** Plain markdown injected as the agent's system instructions. condash reads
   *  it at spawn and wraps it into a transient `--agent-file` (kimi's
   *  `agent.system_prompt_args.ROLE_ADDITIONAL`). Default `~/.kimi/AGENTS.md`,
   *  written by `condash skills install`. Blank = no injected instructions. */
  instructionsFile?: string;
  /** `--model <model>`. Blank = use the kimi config-file default. */
  model?: string;
  /** `--thinking` (true) / `--no-thinking` (false) / config default (undefined). */
  thinking?: boolean;
  /** `--plan` — start in plan mode. */
  plan?: boolean;
  /** `--config <string>` — inline TOML/JSON config (escape hatch). Blank = omit. */
  configInline?: string;
}

/** Fixed reasoning-effort values offered in the variant editor, ascending.
 *  opencode's documented enum (1.15.10); the variant `options` bag is freeform,
 *  so a provider that doesn't recognise a value just ignores it. */
export const OPENCODE_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

/** opencode's built-in agent names, offered as datalist suggestions. `agent.<name>`
 *  is a freeform Record, so any other (custom) name is equally valid. */
export const OPENCODE_AGENT_NAMES = ['build', 'plan', 'general', 'explore', 'scout'] as const;

/** The built-in agents opencode treats as *primary* (switchable with Tab). The
 *  rest of `OPENCODE_AGENT_NAMES` (general/explore/scout) are subagents. */
export const OPENCODE_PRIMARY_BUILTINS = ['build', 'plan'] as const;

/** True when `name` is one of opencode's built-in agents. condash never writes a
 *  `mode` for these — it preserves opencode's own default (build/plan primary;
 *  general/explore/scout subagent). */
export function isBuiltinOpencodeAgent(name: string): boolean {
  return (OPENCODE_AGENT_NAMES as readonly string[]).includes(name);
}

/** True when `name` is a built-in *primary* agent (build/plan) — used to render
 *  its primary toggle as checked-and-disabled. */
export function isBuiltinPrimaryOpencodeAgent(name: string): boolean {
  return (OPENCODE_PRIMARY_BUILTINS as readonly string[]).includes(name);
}

/** `textVerbosity` values opencode accepts (OpenAI-style). */
export const OPENCODE_TEXT_VERBOSITIES = ['low', 'medium', 'high'] as const;

/** `reasoningSummary` values offered in the UI. Freeform in opencode; `auto` is
 *  the standard, `concise`/`detailed` are the OpenAI summary modes. */
export const OPENCODE_REASONING_SUMMARIES = ['auto', 'concise', 'detailed'] as const;

/** A reasoning-options bundle for one row of the agent table. Blank fields are
 *  omitted. The `reasoningEffort` doubles as the emitted variant **name** (so the
 *  opencode footer shows the effort and ctrl+t cycles efforts). */
export interface OpencodeAgentOptions {
  reasoningEffort?: string;
  textVerbosity?: string;
  reasoningSummary?: string;
}

/** A per-agent row of the options table: an opencode agent name, an optional own
 *  model (e.g. plan-on-kimi), and its reasoning options. */
export interface OpencodeAgentRow extends OpencodeAgentOptions {
  agent: string;
  model?: string;
  /** Emit `agent.<name>.mode = "primary"` so a *custom* agent becomes switchable
   *  in opencode (Tab). Ignored for built-in names — build/plan are already
   *  primary, general/explore/scout are subagents, and condash never overrides a
   *  built-in's mode. Defaults to true when a custom row is added in the UI. */
  primary?: boolean;
}

/**
 * opencode harness config. Rendered into an inline `OPENCODE_CONFIG_CONTENT`
 * JSON document (no `opencode.json` file needed — same trick as the
 * `opencode-deepseek-auto` wrapper). The reasoning UI is a single table: a
 * `default` row (this `model` + `defaultOptions`) applied to every agent, and
 * per-agent rows (`agentOptions`) that override the model and/or options. Under
 * the hood condash emits opencode **variants** named by effort so the TUI footer
 * shows each agent's effort and ctrl+t cycles them.
 */
export interface OpencodeAgentConfig {
  /** Top-level `model` (`<provider>/<model>`) — the default row's model, used by
   *  every agent that doesn't override it. */
  model: string;
  /** Sets `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` so only `.opencode/` skills load. */
  disableExternalSkills: boolean;
  /** The default row's reasoning options, applied to every agent (unless a
   *  per-agent row overrides). */
  defaultOptions?: OpencodeAgentOptions;
  /** Per-agent rows: own model and/or reasoning options. */
  agentOptions?: OpencodeAgentRow[];
  /** Raw JSON merged into the inline config — escape hatch for any other
   *  opencode.json key (theme, provider, mcp, …). Blank = none. */
  extraConfigJson?: string;
}

/**
 * agentsconf harness config. Deliberately minimal: the only property is the
 * binary to run. That binary (shipped by `@agentsconf` to `~/bin`) owns all
 * agent configuration — model, env, instructions, skills — so condash sets
 * nothing else. condash launches it as `<binary>` for a terminal and
 * `<binary> --run "<PROMPT>"` for a task.
 */
export interface AgentsconfAgentConfig {
  /** Executable on `$PATH` (e.g. `claude-deepseek-auto`). Run verbatim. */
  binary: string;
}

/**
 * A stored agent definition. Persisted as one JSON file per agent at
 * `<conception>/agents/<slug>.json`. Identity is the `slug` (the filename stem);
 * `name` is a free-form display label. Carries NO secret value — only
 * `secretEnv`, the name of the var in `agents/.env` to resolve at spawn time
 * (unused by `agentsconf`, whose binary owns its own auth).
 * Discriminated union on `harness`.
 */
export type AgentDef =
  | { harness: 'claude'; name: string; slug: string; secretEnv?: string; config: ClaudeAgentConfig }
  | { harness: 'kimi'; name: string; slug: string; secretEnv?: string; config: KimiAgentConfig }
  | {
      harness: 'opencode';
      name: string;
      slug: string;
      secretEnv?: string;
      config: OpencodeAgentConfig;
    }
  | {
      harness: 'agentsconf';
      name: string;
      slug: string;
      secretEnv?: string;
      config: AgentsconfAgentConfig;
    };

/** Lowercase-kebab slug pattern: the agent identity / filename stem. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when `value` is a valid agent slug (lowercase letters, digits, single
 *  hyphens — no leading/trailing/double hyphen). Enforced on write. */
export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/** Reduce free text to a lowercase-kebab slug: lowercase, non-alphanumerics
 *  collapse to single hyphens, leading/trailing hyphens trimmed. Returns `''`
 *  for input with no alphanumerics. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Suggested slug for a new agent: the display name slugified under the
 *  harness's label prefix (e.g. opencode + "DeepSeek Auto" → `opencode-deepseek-auto`).
 *  The prefix keeps slugs unique across harnesses that share a display name. */
export function suggestSlug(harness: HarnessId, name: string): string {
  return slugify(`${HARNESSES[harness].label}-${name}`);
}

/** Renderer-facing agent summary. Carries token *presence* — never the value
 *  (secrets stay in the main process). */
export interface AgentListItem {
  /** Stable identity = filename stem; the IPC + list key. */
  slug: string;
  /** Free-form display label. */
  name: string;
  harness: HarnessId;
  secretEnv?: string;
  tokenPresent: boolean;
  /** One-line preview of the command this agent launches (binary + args, token
   *  not included), shown on the agent row. */
  command: string;
}

/** Spawn preview for the Agents pane "view full config" panel. The secret value
 *  is never included — auth env vars show a `$SECRET_ENV` reference instead. */
export interface AgentSpawnPreview {
  command: string;
  args: string[];
  env: Record<string, string>;
  unsetEnv: string[];
}

// ---------------------------------------------------------------------------
// Spawn — how condash actually runs `<harness>-<model_variant>`
// ---------------------------------------------------------------------------

/** Result of resolving an agent into a runnable command. */
export interface SpawnSpec {
  command: string;
  args: string[];
  /** Env vars to set on top of the inherited login environment. */
  env: Record<string, string>;
  /** Env vars to delete from the inherited environment (e.g. claude's
   *  defensive cloud-routing unsets, or the unused auth var). */
  unsetEnv: string[];
}

/** Thrown when an agent declares a `secretEnv` that resolves to nothing. */
export class MissingAgentSecretError extends Error {
  constructor(
    readonly secretEnv: string,
    readonly agent: string,
  ) {
    super(`${agent}: ${secretEnv} is not set — add it to agents/.env (key=value), then relaunch.`);
    this.name = 'MissingAgentSecretError';
  }
}

/**
 * Build the spawn spec for an agent. `resolveSecret` looks a name up in the
 * conception's `agents/.env`; it returns `undefined` for an absent/blank key.
 * Throws `MissingAgentSecretError` when a declared secret is unresolved.
 *
 * `initialPrompt` is an optional first user message injected as a CLI argument
 * so the prompt lands as part of the spawn command rather than via pty.write()
 * after a blind settle delay. Supported by claude (positional arg) and opencode
 * (`--prompt`); ignored by kimi (no interactive initial-prompt support).
 */
export function buildSpawn(
  def: AgentDef,
  resolveSecret: (name: string) => string | undefined,
  initialPrompt?: string,
): SpawnSpec {
  switch (def.harness) {
    case 'claude':
      return buildClaudeSpawn(def, resolveSecret, initialPrompt);
    case 'kimi':
      return buildKimiSpawn(def, resolveSecret);
    case 'opencode':
      return buildOpencodeSpawn(def, resolveSecret, initialPrompt);
    case 'agentsconf':
      return buildAgentsconfSpawn(def, initialPrompt);
  }
}

/** Export a declared token under its own variable name (the name the user
 *  chose, e.g. `DEEPSEEK_API_KEY`) so the harness's provider picks it up from
 *  the environment. Throws when the secret is declared but unresolved. claude
 *  handles its token specially (ANTHROPIC_*), so it does not use this. */
function injectSecret(
  def: AgentDef,
  resolveSecret: (name: string) => string | undefined,
  env: Record<string, string>,
): void {
  if (!def.secretEnv) return;
  const key = resolveSecret(def.secretEnv);
  if (!key) throw new MissingAgentSecretError(def.secretEnv, def.name);
  env[def.secretEnv] = key;
}

/** One-line `binary args` preview of how an agent launches (the token value is
 *  never shown — auth vars resolve to a `$SECRET_ENV` reference). Pure, so the
 *  renderer can compute a live preview without an IPC round-trip. */
export function previewCommandLine(def: AgentDef): string {
  const spec = buildSpawn(def, (name) => `$${name}`);
  return [spec.command, ...spec.args].join(' ');
}

function buildClaudeSpawn(
  def: Extract<AgentDef, { harness: 'claude' }>,
  resolveSecret: (name: string) => string | undefined,
  initialPrompt?: string,
): SpawnSpec {
  const cfg = def.config;
  const extraArgs = initialPrompt ? [initialPrompt] : [];

  // Native claude (no provider remap): an empty baseUrl means "run bare
  // `claude`" — claude uses the user's own Anthropic login + model config, so
  // condash sets nothing.
  if (!cfg.baseUrl.trim()) {
    return { command: HARNESSES.claude.binary, args: extraArgs, env: {}, unsetEnv: [] };
  }

  const env: Record<string, string> = {};
  const unsetEnv: string[] = [];

  const key = def.secretEnv ? resolveSecret(def.secretEnv) : undefined;
  if (def.secretEnv && !key) {
    throw new MissingAgentSecretError(def.secretEnv, def.name);
  }

  env.ANTHROPIC_BASE_URL = cfg.baseUrl;
  if (key) {
    if (cfg.authStyle === 'apikey') {
      env.ANTHROPIC_API_KEY = key;
      unsetEnv.push('ANTHROPIC_AUTH_TOKEN');
    } else {
      env.ANTHROPIC_AUTH_TOKEN = key;
      unsetEnv.push('ANTHROPIC_API_KEY');
    }
  }

  env.ANTHROPIC_MODEL = cfg.model;
  env.ANTHROPIC_SMALL_FAST_MODEL = cfg.smallFastModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cfg.haikuAlias;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = cfg.sonnetAlias;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = cfg.opusAlias;
  env.CLAUDE_CODE_SUBAGENT_MODEL = cfg.subagentModel;
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(cfg.maxContextTokens);
  if (cfg.effortLevel.trim()) env.CLAUDE_CODE_EFFORT_LEVEL = cfg.effortLevel;

  if (cfg.disableCaching) env.DISABLE_PROMPT_CACHING = '1';
  if (cfg.disable1M) env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
  if (cfg.disableAdaptiveThinking) env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1';
  if (cfg.disableTelemetry) env.DISABLE_TELEMETRY = '1';
  if (cfg.disableErrorReporting) env.DISABLE_ERROR_REPORTING = '1';
  if (cfg.disableClaudeApiSkill) env.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL = '1';

  // Defensive: ensure no cloud-provider routing intercepts the call.
  unsetEnv.push(
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE',
  );

  return { command: HARNESSES.claude.binary, args: extraArgs, env, unsetEnv };
}

function buildKimiSpawn(
  def: Extract<AgentDef, { harness: 'kimi' }>,
  resolveSecret: (name: string) => string | undefined,
): SpawnSpec {
  const cfg = def.config;
  const args: string[] = [];
  // Note: `--agent-file` is added by the main-process launcher
  // (`resolveAgentSpawn`), which generates a transient agent-file from
  // `instructionsFile` at spawn — it isn't known to this pure builder.
  if (cfg.model?.trim()) args.push('--model', cfg.model);
  if (cfg.thinking === true) args.push('--thinking');
  else if (cfg.thinking === false) args.push('--no-thinking');
  if (cfg.plan) args.push('--plan');
  if (cfg.configInline?.trim()) args.push('--config', cfg.configInline);
  const env: Record<string, string> = {};
  injectSecret(def, resolveSecret, env);
  return { command: HARNESSES.kimi.binary, args, env, unsetEnv: [] };
}

function buildOpencodeSpawn(
  def: Extract<AgentDef, { harness: 'opencode' }>,
  resolveSecret: (name: string) => string | undefined,
  initialPrompt?: string,
): SpawnSpec {
  const cfg = def.config;
  const env: Record<string, string> = {};
  injectSecret(def, resolveSecret, env);
  if (cfg.disableExternalSkills) env.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1';

  // Inline config (no opencode.json needed). extraConfigJson seeds the base;
  // the agent options table wins over it.
  const config: Record<string, unknown> = {};
  if (cfg.extraConfigJson?.trim()) Object.assign(config, JSON.parse(cfg.extraConfigJson));
  if (cfg.model.trim()) config.model = cfg.model;
  const defaultModel = cfg.model.trim();

  // The table emits plain model options (not variants - opencode's footer ignores
  // configured variants anyway, and these reach the request the same way). The
  // default row sets the default model's base `options` (every agent on that model
  // inherits it); each per-agent row sets `agent.<name>.options` (+ `agent.<name>.model`),
  // which opencode layers over the model base.
  const optionsOf = (opts?: OpencodeAgentOptions): Record<string, unknown> | undefined => {
    if (!opts) return undefined;
    const out: Record<string, unknown> = {};
    if (opts.reasoningEffort?.trim()) out.reasoningEffort = opts.reasoningEffort.trim();
    if (opts.textVerbosity?.trim()) out.textVerbosity = opts.textVerbosity.trim();
    if (opts.reasoningSummary?.trim()) out.reasoningSummary = opts.reasoningSummary.trim();
    return Object.keys(out).length > 0 ? out : undefined;
  };

  // Default row -> base options on the default model.
  const defaultOptions = optionsOf(cfg.defaultOptions);
  if (defaultOptions && defaultModel) setModelOptions(config, defaultModel, defaultOptions);

  // Per-agent rows -> `agent.<name>.{model,options}`. Explicit row options win; a
  // row that only overrides the model carries the default options onto it (the
  // default model's base options don't reach a different model).
  const agent: Record<string, unknown> = { ...((config.agent as Record<string, unknown>) ?? {}) };
  for (const row of cfg.agentOptions ?? []) {
    const name = row.agent.trim();
    if (!name) continue;
    const model = row.model?.trim();
    const options = optionsOf(row) ?? (model ? defaultOptions : undefined);
    // A custom (non-built-in) row marked primary emits `mode: "primary"` so it
    // shows up as a switchable agent. Built-in names keep opencode's own mode.
    const primary = row.primary === true && !isBuiltinOpencodeAgent(name);
    if (!model && !options && !primary) continue;
    const entry = { ...((agent[name] as Record<string, unknown>) ?? {}) };
    if (primary) entry.mode = 'primary';
    if (model) entry.model = model;
    if (options) {
      entry.options = { ...((entry.options as Record<string, unknown>) ?? {}), ...options };
    }
    agent[name] = entry;
  }
  if (Object.keys(agent).length > 0) config.agent = agent;

  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

  const extraArgs = initialPrompt ? ['--prompt', initialPrompt] : [];
  return { command: HARNESSES.opencode.binary, args: extraArgs, env, unsetEnv: [] };
}

/**
 * agentsconf spawn — run the configured binary verbatim. The binary owns model,
 * env, instructions, and skills, so condash sets no env. A task's initial prompt
 * is passed as `--run "<PROMPT>"`; a terminal launch (no prompt) runs bare.
 */
function buildAgentsconfSpawn(
  def: Extract<AgentDef, { harness: 'agentsconf' }>,
  initialPrompt?: string,
): SpawnSpec {
  const args = initialPrompt ? ['--run', initialPrompt] : [];
  return { command: def.config.binary, args, env: {}, unsetEnv: [] };
}

/**
 * Navigate to `provider.<id>.models.<model>` inside an opencode config object,
 * creating the nesting on demand and preserving anything already present (e.g.
 * from `extraConfigJson`), apply `mutate` to that model entry, and write the
 * chain back. No-op for a `modelRef` not in `provider/model` form. The provider
 * id is everything before the first `/`; the rest is the model id (which may
 * itself contain slashes, e.g. `openrouter/anthropic/claude`).
 */
function withModelEntry(
  config: Record<string, unknown>,
  modelRef: string,
  mutate: (modelEntry: Record<string, unknown>) => void,
): void {
  const slash = modelRef.indexOf('/');
  if (slash <= 0 || slash >= modelRef.length - 1) return;
  const providerId = modelRef.slice(0, slash);
  const modelId = modelRef.slice(slash + 1);

  const provider = (config.provider as Record<string, unknown>) ?? {};
  const providerEntry = (provider[providerId] as Record<string, unknown>) ?? {};
  const models = (providerEntry.models as Record<string, unknown>) ?? {};
  const modelEntry = (models[modelId] as Record<string, unknown>) ?? {};

  mutate(modelEntry);

  models[modelId] = modelEntry;
  providerEntry.models = models;
  provider[providerId] = providerEntry;
  config.provider = provider;
}

/** Merge `options` into `provider.<id>.models.<model>.options`, preserving any
 *  keys already present (e.g. from `extraConfigJson`). */
function setModelOptions(
  config: Record<string, unknown>,
  modelRef: string,
  options: Record<string, unknown>,
): void {
  withModelEntry(config, modelRef, (modelEntry) => {
    modelEntry.options = { ...((modelEntry.options as Record<string, unknown>) ?? {}), ...options };
  });
}

// ---------------------------------------------------------------------------
// Defaults — used by the Agents pane to scaffold a new agent
// ---------------------------------------------------------------------------

/**
 * Default claude config: no provider remap. An empty `baseUrl` plus no token
 * makes condash run bare `claude`, which uses the user's own Anthropic login
 * and model config. The Agents editor exposes every field for the user to point
 * the agent at an alt-provider endpoint by hand.
 */
export function defaultClaudeConfig(): ClaudeAgentConfig {
  return {
    baseUrl: '',
    authStyle: 'bearer',
    model: '',
    smallFastModel: '',
    haikuAlias: '',
    sonnetAlias: '',
    opusAlias: '',
    subagentModel: '',
    maxContextTokens: 0,
    effortLevel: '',
    disableCaching: false,
    disable1M: false,
    disableAdaptiveThinking: false,
    disableTelemetry: false,
    disableErrorReporting: false,
    disableClaudeApiSkill: false,
  };
}

/** Default kimi-cli config. */
export function defaultKimiConfig(): KimiAgentConfig {
  return { instructionsFile: '~/.kimi/AGENTS.md' };
}

/** Build the kimi agent-file YAML that injects `instructions` as the agent's
 *  `system_prompt_args.ROLE_ADDITIONAL` (extending the default agent). The
 *  launcher writes this to a transient file and passes it as `--agent-file`. */
export function kimiAgentFileYaml(instructions: string): string {
  const indented = instructions.replace(/\n/g, '\n      ');
  return `version: 1\nagent:\n  extend: default\n  system_prompt_args:\n    ROLE_ADDITIONAL: |\n      ${indented}\n`;
}

/** Default opencode config for a `<provider>/<model>` string. */
export function defaultOpencodeConfig(model: string): OpencodeAgentConfig {
  return { model, disableExternalSkills: true };
}

/** Default agentsconf config — an empty binary the user fills in. */
export function defaultAgentsconfConfig(): AgentsconfAgentConfig {
  return { binary: '' };
}
