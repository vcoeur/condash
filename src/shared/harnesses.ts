/**
 * Unified harness registry — the single source of truth for the agent CLIs
 * condash supports (claude, kimi-cli, opencode).
 *
 * A *harness* is the unit that carries every per-CLI specific. It has TWO
 * responsibilities, both keyed off this one list:
 *
 *   1. **skills + AGENTS.md compile target** — `COMPILE_TARGETS` and
 *      `AGENTS_MD_OUTPUTS` derive from `HARNESSES` so the set lives in one
 *      place (see `src/skillspec/types.ts`, `src/agents-md/compile.ts`).
 *   2. **agent configuration** — an *agent* is `<harness>-<model_variant>`
 *      (a harness + a harness-specific config + an optional API token). The
 *      `buildSpawn` adapter below knows the *correct* invocation to run each
 *      agent: claude exports `ANTHROPIC_*` env, kimi-cli points at its
 *      `--agent-file` YAML, opencode passes `--model`.
 *
 * Pure module — no Node / zod imports — so main, renderer, and the CLI bundle
 * can all import it. Runtime validation of the on-disk JSON lives in the main
 * loader (`src/main/agents/`).
 */

/** Canonical harness id. Matches the on-disk config dirs (`.claude/`, `.kimi/`,
 *  `.opencode/`) and the existing skills/AGENTS.md compile targets. */
export type HarnessId = 'claude' | 'kimi' | 'opencode';

export const HARNESS_IDS: readonly HarnessId[] = ['claude', 'kimi', 'opencode'] as const;

/** Per-harness identity + the skills/AGENTS.md output locations. */
export interface HarnessMeta {
  id: HarnessId;
  /** User-facing label — the CLI's own product name (kimi's CLI is "kimi-cli"). */
  label: string;
  /** Executable spawned on `$PATH`. Note kimi-cli's binary is `kimi`. */
  binary: string;
  /** Compiled AGENTS.md / CLAUDE.md output path, relative to conception root. */
  agentsMdOutput: string;
  /** Compiled skills output dir, relative to conception root. */
  skillsOutputDir: string;
}

export const HARNESSES: Record<HarnessId, HarnessMeta> = {
  claude: {
    id: 'claude',
    label: 'claude',
    binary: 'claude',
    agentsMdOutput: '.claude/CLAUDE.md',
    skillsOutputDir: '.claude/skills',
  },
  kimi: {
    id: 'kimi',
    label: 'kimi-cli',
    binary: 'kimi',
    agentsMdOutput: '.kimi/AGENTS.md',
    skillsOutputDir: '.kimi/skills',
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    binary: 'opencode',
    agentsMdOutput: '.opencode/AGENTS.md',
    skillsOutputDir: '.opencode/skills',
  },
};

export function isHarnessId(value: unknown): value is HarnessId {
  return value === 'claude' || value === 'kimi' || value === 'opencode';
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

/** opencode's built-in agent names, offered as override targets. `agent.<name>`
 *  is a freeform Record, so naming an agent that doesn't exist is harmless. */
export const OPENCODE_AGENT_NAMES = ['build', 'plan', 'general', 'explore', 'scout'] as const;

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
 * A stored agent definition. Persisted as one JSON file per agent at
 * `<conception>/agents/<slug>.json`. Identity is the `slug` (the filename stem);
 * `name` is a free-form display label. Carries NO secret value — only
 * `secretEnv`, the name of the var in `agents/.env` to resolve at spawn time.
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

  // Each distinct reasoning effort becomes a variant *named by the effort* (so
  // the opencode footer shows the effort and ctrl+t cycles them); the variant
  // carries that row's effort + verbosity + summary. Last write wins if the same
  // effort appears with different verbosity/summary. `registerVariant` returns
  // the effort name (= variant name) to assign, or undefined when no effort.
  const variantOptions = new Map<string, Record<string, unknown>>();
  const registerVariant = (opts?: OpencodeAgentOptions): string | undefined => {
    const effort = opts?.reasoningEffort?.trim();
    if (!effort) return undefined;
    const variant: Record<string, unknown> = { reasoningEffort: effort };
    if (opts?.textVerbosity?.trim()) variant.textVerbosity = opts.textVerbosity.trim();
    if (opts?.reasoningSummary?.trim()) variant.reasoningSummary = opts.reasoningSummary.trim();
    variantOptions.set(effort, variant);
    return effort;
  };

  const defaultVariant = registerVariant(cfg.defaultOptions);
  const rows = new Map(
    (cfg.agentOptions ?? []).filter((r) => r.agent.trim()).map((r) => [r.agent.trim(), r] as const),
  );

  // Per-agent `agent.<name>.{model,variant}`. The default variant applies to every
  // built-in agent unless its row sets an effort; a variant only applies to the
  // agent's configured model, so pin the agent's model (its row's, else the
  // default) whenever a variant is set.
  const agent: Record<string, unknown> = { ...((config.agent as Record<string, unknown>) ?? {}) };
  for (const name of OPENCODE_AGENT_NAMES) {
    const row = rows.get(name);
    const model = row?.model?.trim();
    const variant = registerVariant(row) ?? defaultVariant;
    if (!model && !variant) continue;
    const entry = { ...((agent[name] as Record<string, unknown>) ?? {}) };
    if (model) entry.model = model;
    if (variant) {
      entry.variant = variant;
      if (entry.model == null && defaultModel) entry.model = defaultModel;
    }
    agent[name] = entry;
  }
  if (Object.keys(agent).length > 0) config.agent = agent;

  // Emit the collected variants under `provider.<id>.models.<model>.variants` for
  // every model the agents reference (default + any per-agent model override), so
  // each `agent.<name>.variant` resolves whichever model runs.
  const referencedModels = new Set<string>();
  if (defaultModel) referencedModels.add(defaultModel);
  for (const row of rows.values()) if (row.model?.trim()) referencedModels.add(row.model.trim());
  for (const [name, options] of variantOptions) {
    for (const modelRef of referencedModels) setModelVariant(config, modelRef, name, options);
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

  const extraArgs = initialPrompt ? ['--prompt', initialPrompt] : [];
  return { command: HARNESSES.opencode.binary, args: extraArgs, env, unsetEnv: [] };
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

/** Set the named variant `provider.<id>.models.<model>.variants[name]` to the
 *  given options object, preserving any sibling variants. */
function setModelVariant(
  config: Record<string, unknown>,
  modelRef: string,
  name: string,
  options: Record<string, unknown>,
): void {
  if (!name) return;
  withModelEntry(config, modelRef, (modelEntry) => {
    const variants = (modelEntry.variants as Record<string, unknown>) ?? {};
    variants[name] = options;
    modelEntry.variants = variants;
  });
}

// ---------------------------------------------------------------------------
// Defaults + presets — used by the Agents pane to scaffold a new agent
// ---------------------------------------------------------------------------

/** The `DISABLE_*` toggle defaults shared by every claude-on-alt-provider preset. */
const CLAUDE_ALT_PROVIDER_TOGGLES = {
  disableCaching: false,
  disable1M: true,
  disableAdaptiveThinking: true,
  disableTelemetry: true,
  disableErrorReporting: true,
  disableClaudeApiSkill: true,
} as const;

/** A claude config preset + the env var it expects the token under. */
export interface ClaudePreset {
  config: ClaudeAgentConfig;
  secretEnv: string;
}

/**
 * Known claude model-variant presets, mirroring the agentsconf wrappers. The
 * Agents pane fills the full config from one of these when the user picks a
 * variant; advanced overrides edit individual fields afterwards.
 */
export const CLAUDE_PRESETS: Record<string, ClaudePreset> = {
  native: {
    // No provider remap: empty baseUrl + no token → condash runs bare `claude`,
    // which uses the user's own Anthropic login and model config.
    secretEnv: '',
    config: {
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
    },
  },
  'deepseek-v4-pro': {
    secretEnv: 'DEEPSEEK_API_KEY',
    config: {
      baseUrl: 'https://api.deepseek.com/anthropic',
      authStyle: 'bearer',
      model: 'deepseek-v4-pro',
      smallFastModel: 'deepseek-v4-pro',
      haikuAlias: 'deepseek-v4-pro',
      sonnetAlias: 'deepseek-v4-pro',
      opusAlias: 'deepseek-v4-pro',
      subagentModel: 'deepseek-v4-pro',
      maxContextTokens: 1000000,
      effortLevel: 'max',
      ...CLAUDE_ALT_PROVIDER_TOGGLES,
    },
  },
  'deepseek-v4-flash': {
    secretEnv: 'DEEPSEEK_API_KEY',
    config: {
      baseUrl: 'https://api.deepseek.com/anthropic',
      authStyle: 'bearer',
      model: 'deepseek-v4-flash',
      smallFastModel: 'deepseek-v4-flash',
      haikuAlias: 'deepseek-v4-flash',
      sonnetAlias: 'deepseek-v4-flash',
      opusAlias: 'deepseek-v4-flash',
      subagentModel: 'deepseek-v4-flash',
      maxContextTokens: 1000000,
      effortLevel: 'max',
      ...CLAUDE_ALT_PROVIDER_TOGGLES,
    },
  },
  'deepseek-auto': {
    secretEnv: 'DEEPSEEK_API_KEY',
    config: {
      baseUrl: 'https://api.deepseek.com/anthropic',
      authStyle: 'bearer',
      model: 'deepseek-v4-flash',
      smallFastModel: 'deepseek-v4-flash',
      haikuAlias: 'deepseek-v4-flash',
      sonnetAlias: 'deepseek-v4-pro',
      opusAlias: 'deepseek-v4-pro',
      subagentModel: 'deepseek-v4-flash',
      maxContextTokens: 1000000,
      effortLevel: 'max',
      ...CLAUDE_ALT_PROVIDER_TOGGLES,
    },
  },
  kimi: {
    secretEnv: 'KIMI_API_KEY',
    config: {
      baseUrl: 'https://api.kimi.com/coding/',
      authStyle: 'bearer',
      model: 'kimi-k2.6',
      smallFastModel: 'kimi-k2.6',
      haikuAlias: 'kimi-k2.6',
      sonnetAlias: 'kimi-k2.6',
      opusAlias: 'kimi-k2.6',
      subagentModel: 'kimi-k2.6',
      maxContextTokens: 262144,
      effortLevel: 'max',
      ...CLAUDE_ALT_PROVIDER_TOGGLES,
    },
  },
};

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

/** An opencode config preset + the env var it expects the token under. */
export interface OpencodePreset {
  config: OpencodeAgentConfig;
  secretEnv: string;
}

/**
 * Known opencode model-variant presets, mirroring the agentsconf
 * `opencode-<provider>` wrappers. `deepseek-auto` tiers build/plan onto the
 * premium model and defaults everything else to the cheap one — exactly the
 * `opencode-deepseek-auto` wrapper's behaviour.
 */
// opencode authenticates providers through its own auth store (`opencode auth
// login`), not an env-var key — the agentsconf `opencode-*` wrappers carried no
// key for exactly this reason. So presets leave `secretEnv` empty; injecting a
// stray `DEEPSEEK_API_KEY` can collide with opencode's OAuth and hang launch.
// Set a token only if your provider genuinely reads one from the environment.
export const OPENCODE_PRESETS: Record<string, OpencodePreset> = {
  'deepseek-v4-pro': {
    secretEnv: '',
    config: { model: 'deepseek/deepseek-v4-pro', disableExternalSkills: true },
  },
  'deepseek-v4-flash': {
    secretEnv: '',
    config: { model: 'deepseek/deepseek-v4-flash', disableExternalSkills: true },
  },
  'deepseek-auto': {
    secretEnv: '',
    config: {
      model: 'deepseek/deepseek-v4-flash',
      disableExternalSkills: true,
      agentOptions: [
        { agent: 'build', model: 'deepseek/deepseek-v4-pro' },
        { agent: 'plan', model: 'deepseek/deepseek-v4-pro' },
      ],
    },
  },
  kimi: {
    secretEnv: '',
    config: { model: 'kimi-for-coding/kimi-k2-thinking', disableExternalSkills: true },
  },
};
