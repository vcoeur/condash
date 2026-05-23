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
  disableCaching: boolean;
  disable1M: boolean;
  disableAdaptiveThinking: boolean;
  disableTelemetry: boolean;
  disableErrorReporting: boolean;
  disableClaudeApiSkill: boolean;
}

/** kimi-cli harness config. */
export interface KimiAgentConfig {
  /** `--agent-file <file>` — custom agent YAML. Blank = omit the flag. */
  agentFile: string;
  /** `--model <model>`. Blank = use the kimi config-file default. */
  model?: string;
  /** `--thinking` (true) / `--no-thinking` (false) / config default (undefined). */
  thinking?: boolean;
  /** `--plan` — start in plan mode. */
  plan?: boolean;
  /** `--config <string>` — inline TOML/JSON config (escape hatch). Blank = omit. */
  configInline?: string;
}

/**
 * opencode harness config. Rendered into an inline `OPENCODE_CONFIG_CONTENT`
 * JSON document (no `opencode.json` file needed — same trick as the
 * `opencode-deepseek-auto` wrapper): top-level `model` is the default; the
 * per-agent `build` / `plan` model overrides and any `extraConfigJson` keys
 * are merged in.
 */
export interface OpencodeAgentConfig {
  /** Top-level `model` (`<provider>/<model>`) — opencode's default model. */
  model: string;
  /** `agent.build.model` override. Blank = inherit the default. */
  buildModel?: string;
  /** `agent.plan.model` override. Blank = inherit the default. */
  planModel?: string;
  /** Sets `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` so only `.opencode/` skills load. */
  disableExternalSkills: boolean;
  /** Raw JSON merged into the inline config — escape hatch for any other
   *  opencode.json key (theme, provider, mcp, …). Blank = none. */
  extraConfigJson?: string;
}

/**
 * A stored agent definition. Persisted as one JSON file per agent at
 * `<conception>/agents/<harness>-<model_variant>.json`. Carries NO secret
 * value — only `secretEnv`, the name of the var in `agents/.env` to resolve at
 * spawn time. Discriminated union on `harness`.
 */
export type AgentDef =
  | { harness: 'claude'; modelVariant: string; secretEnv?: string; config: ClaudeAgentConfig }
  | { harness: 'kimi'; modelVariant: string; secretEnv?: string; config: KimiAgentConfig }
  | { harness: 'opencode'; modelVariant: string; secretEnv?: string; config: OpencodeAgentConfig };

/** Derived agent name `<harness-label>-<model_variant>` (e.g. `claude-deepseek-v4-pro`,
 *  `kimi-cli-native`, `opencode-deepseek-v4-pro`). Never stored — always derived so
 *  the naming convention can't drift. Also the JSON filename stem + tab label. */
export function agentName(def: Pick<AgentDef, 'harness' | 'modelVariant'>): string {
  return `${HARNESSES[def.harness].label}-${def.modelVariant}`;
}

/** Renderer-facing agent summary. Carries token *presence* — never the value
 *  (secrets stay in the main process). */
export interface AgentListItem {
  name: string;
  harness: HarnessId;
  modelVariant: string;
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
 */
export function buildSpawn(
  def: AgentDef,
  resolveSecret: (name: string) => string | undefined,
): SpawnSpec {
  switch (def.harness) {
    case 'claude':
      return buildClaudeSpawn(def, resolveSecret);
    case 'kimi':
      return buildKimiSpawn(def);
    case 'opencode':
      return buildOpencodeSpawn(def);
  }
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
): SpawnSpec {
  const cfg = def.config;

  // Native claude (no provider remap): an empty baseUrl means "run bare
  // `claude`" — claude uses the user's own Anthropic login + model config, so
  // condash sets nothing.
  if (!cfg.baseUrl.trim()) {
    return { command: HARNESSES.claude.binary, args: [], env: {}, unsetEnv: [] };
  }

  const env: Record<string, string> = {};
  const unsetEnv: string[] = [];

  const key = def.secretEnv ? resolveSecret(def.secretEnv) : undefined;
  if (def.secretEnv && !key) {
    throw new MissingAgentSecretError(def.secretEnv, agentName(def));
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

  return { command: HARNESSES.claude.binary, args: [], env, unsetEnv };
}

function buildKimiSpawn(def: Extract<AgentDef, { harness: 'kimi' }>): SpawnSpec {
  const cfg = def.config;
  const args: string[] = [];
  if (cfg.agentFile.trim()) args.push('--agent-file', cfg.agentFile);
  if (cfg.model?.trim()) args.push('--model', cfg.model);
  if (cfg.thinking === true) args.push('--thinking');
  else if (cfg.thinking === false) args.push('--no-thinking');
  if (cfg.plan) args.push('--plan');
  if (cfg.configInline?.trim()) args.push('--config', cfg.configInline);
  return { command: HARNESSES.kimi.binary, args, env: {}, unsetEnv: [] };
}

function buildOpencodeSpawn(def: Extract<AgentDef, { harness: 'opencode' }>): SpawnSpec {
  const cfg = def.config;
  const env: Record<string, string> = {};
  if (cfg.disableExternalSkills) env.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1';

  // Inline config (no opencode.json needed). extraConfigJson seeds the base;
  // model + per-agent overrides win over it.
  const config: Record<string, unknown> = {};
  if (cfg.extraConfigJson?.trim()) Object.assign(config, JSON.parse(cfg.extraConfigJson));
  if (cfg.model.trim()) config.model = cfg.model;
  const agent: Record<string, unknown> = { ...((config.agent as Record<string, unknown>) ?? {}) };
  if (cfg.buildModel?.trim()) {
    agent.build = { ...((agent.build as Record<string, unknown>) ?? {}), model: cfg.buildModel };
  }
  if (cfg.planModel?.trim()) {
    agent.plan = { ...((agent.plan as Record<string, unknown>) ?? {}), model: cfg.planModel };
  }
  if (Object.keys(agent).length > 0) config.agent = agent;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);

  return { command: HARNESSES.opencode.binary, args: [], env, unsetEnv: [] };
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
      ...CLAUDE_ALT_PROVIDER_TOGGLES,
    },
  },
};

/** Default kimi-cli config. */
export function defaultKimiConfig(): KimiAgentConfig {
  return { agentFile: '~/.kimi/global-agent.yaml' };
}

/** Default opencode config for a `<provider>/<model>` string. */
export function defaultOpencodeConfig(model: string): OpencodeAgentConfig {
  return { model, disableExternalSkills: true };
}
