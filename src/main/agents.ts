/**
 * Agent storage + token resolution (main process only).
 *
 * Agents are defined as one JSON file each at `<conception>/agents/<slug>.json`,
 * where the `slug` (a lowercase-kebab identity) is the filename stem and the
 * stored `name` is a free-form display label. The matching API tokens live in a
 * single gitignored `<conception>/agents/.env` of `NAME=value` lines. Secrets
 * are read here and only here — they reach a child process through the spawn
 * environment, never the renderer.
 */
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join } from 'path';
import { z } from 'zod';
import {
  type AgentDef,
  type AgentListItem,
  type AgentSpawnPreview,
  buildSpawn,
  isValidSlug,
  kimiAgentFileYaml,
  previewCommandLine,
  type SpawnSpec,
} from '../shared/harnesses';

const AGENTS_DIRNAME = 'agents';
const ENV_FILENAME = '.env';

const claudeConfigSchema = z.object({
  baseUrl: z.string(),
  authStyle: z.enum(['bearer', 'apikey']),
  model: z.string(),
  smallFastModel: z.string(),
  haikuAlias: z.string(),
  sonnetAlias: z.string(),
  opusAlias: z.string(),
  subagentModel: z.string(),
  maxContextTokens: z.number(),
  // Default '' so agent JSON written before this field existed still validates.
  effortLevel: z.string().default(''),
  disableCaching: z.boolean(),
  disable1M: z.boolean(),
  disableAdaptiveThinking: z.boolean(),
  disableTelemetry: z.boolean(),
  disableErrorReporting: z.boolean(),
  disableClaudeApiSkill: z.boolean(),
});

const kimiConfigSchema = z.object({
  instructionsFile: z.string().optional(),
  model: z.string().optional(),
  thinking: z.boolean().optional(),
  plan: z.boolean().optional(),
  configInline: z.string().optional(),
});

const isJsonOrBlank = (value: string | undefined): boolean => {
  if (value == null || value.trim() === '') return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

const opencodeConfigSchema = z.object({
  model: z.string(),
  buildModel: z.string().optional(),
  planModel: z.string().optional(),
  disableExternalSkills: z.boolean(),
  effortLevel: z.string().optional(),
  extraConfigJson: z
    .string()
    .optional()
    .refine(isJsonOrBlank, { message: 'extraConfigJson must be valid JSON' }),
});

const agentDefSchema = z.discriminatedUnion('harness', [
  z.object({
    harness: z.literal('claude'),
    name: z.string().min(1),
    // Loose on read so legacy / hand-edited stems still load; `writeAgent`
    // enforces lowercase-kebab via `isValidSlug`.
    slug: z.string().min(1),
    secretEnv: z.string().optional(),
    config: claudeConfigSchema,
  }),
  z.object({
    harness: z.literal('kimi'),
    name: z.string().min(1),
    // Loose on read so legacy / hand-edited stems still load; `writeAgent`
    // enforces lowercase-kebab via `isValidSlug`.
    slug: z.string().min(1),
    secretEnv: z.string().optional(),
    config: kimiConfigSchema,
  }),
  z.object({
    harness: z.literal('opencode'),
    name: z.string().min(1),
    // Loose on read so legacy / hand-edited stems still load; `writeAgent`
    // enforces lowercase-kebab via `isValidSlug`.
    slug: z.string().min(1),
    secretEnv: z.string().optional(),
    config: opencodeConfigSchema,
  }),
]);

function agentsDir(conceptionPath: string): string {
  return join(conceptionPath, AGENTS_DIRNAME);
}

/** Absolute path to the per-conception secrets file. */
export function agentsEnvPath(conceptionPath: string): string {
  return join(agentsDir(conceptionPath), ENV_FILENAME);
}

const ENV_TEMPLATE = `# agents/.env — API tokens for condash agents (gitignored; never commit).
# One NAME=value per line. Each agent's "secretEnv" names the variable it reads.
# Example:
# DEEPSEEK_API_KEY=sk-...
# KIMI_API_KEY=sk-...
`;

/** Raw contents of `<conception>/agents/.env` for the in-app editor. Returns a
 *  commented template (not written to disk) when the file is absent so the
 *  editor opens with guidance. */
export async function readAgentsEnv(conceptionPath: string): Promise<string> {
  try {
    return await fs.readFile(agentsEnvPath(conceptionPath), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ENV_TEMPLATE;
    throw err;
  }
}

/** Write the in-app editor's contents back to `<conception>/agents/.env`,
 *  creating the `agents/` directory if needed. */
export async function writeAgentsEnv(conceptionPath: string, content: string): Promise<void> {
  await fs.mkdir(agentsDir(conceptionPath), { recursive: true });
  await fs.writeFile(agentsEnvPath(conceptionPath), content, 'utf8');
}

/**
 * Guard a slug that's about to become a filesystem path. Rejects only
 * path-unsafe stems — separators, NUL, `.`/`..`, or empty — and otherwise lets
 * the value through (spaces included). The stricter lowercase-kebab rule is a
 * *write*-time concern (`isValidSlug`); read/delete must stay permissive so a
 * legacy or hand-named file (e.g. `opencode-DeepSeek Auto.json`) can still be
 * opened and launched.
 */
function safePathStem(slug: string): string {
  if (slug === '' || slug === '.' || slug === '..' || /[/\\\0]/.test(slug)) {
    throw new Error(`invalid agent slug: ${slug}`);
  }
  return slug;
}

/** Minimal `.env` parser: `NAME=value` lines, `#` comments, optional quotes. */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Read + parse `agents/.env`; `{}` when the file is absent. */
async function readEnv(conceptionPath: string): Promise<Record<string, string>> {
  try {
    const text = await fs.readFile(agentsEnvPath(conceptionPath), 'utf8');
    return parseEnv(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Normalise on-disk JSON to the current `AgentDef` shape. The filename stem is
 * authoritative for `slug` (so a slug can never drift from its file); `name`
 * falls back to a legacy `modelVariant`, then to the stem. Pre-`name`/`slug`
 * files therefore load unchanged — they only migrate on disk when next written.
 */
function normalizeAgentJson(raw: Record<string, unknown>, stem: string): Record<string, unknown> {
  const { modelVariant, name, slug: _ignoredSlug, ...rest } = raw;
  return {
    ...rest,
    name: name ?? modelVariant ?? stem,
    slug: stem,
  };
}

async function readDefFromFile(file: string): Promise<AgentDef> {
  const text = await fs.readFile(file, 'utf8');
  const raw = JSON.parse(text) as Record<string, unknown>;
  const normalized = normalizeAgentJson(raw, basename(file, '.json'));
  return agentDefSchema.parse(normalized) as AgentDef;
}

/**
 * List every valid agent under `<conception>/agents/`. Files that fail to
 * parse/validate are skipped (warned) rather than failing the whole pane.
 * `tokenPresent` reflects whether `secretEnv` resolves to a non-empty value
 * in `agents/.env`.
 */
export async function listAgents(conceptionPath: string): Promise<AgentListItem[]> {
  let names: string[];
  try {
    names = await fs.readdir(agentsDir(conceptionPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const env = await readEnv(conceptionPath);
  const items: AgentListItem[] = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    try {
      const def = await readDefFromFile(join(agentsDir(conceptionPath), file));
      items.push({
        slug: def.slug,
        name: def.name,
        harness: def.harness,
        secretEnv: def.secretEnv,
        tokenPresent: def.secretEnv ? Boolean(env[def.secretEnv]) : true,
        command: previewCommandLine(def),
      });
    } catch (err) {
      console.error(`[agents] skipping ${file}: ${(err as Error).message}`);
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/** Read one agent definition by slug. `null` when absent. Never includes a token. */
export async function readAgent(conceptionPath: string, slug: string): Promise<AgentDef | null> {
  try {
    return await readDefFromFile(join(agentsDir(conceptionPath), `${safePathStem(slug)}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Create or update an agent. The filename is the def's `slug` (validated as
 * lowercase-kebab here, so every written file is clean). The stored slug is
 * pinned to the filename stem. When `previousSlug` is given and differs, the
 * old file is removed (rename).
 */
export async function writeAgent(
  conceptionPath: string,
  def: AgentDef,
  previousSlug?: string,
): Promise<string> {
  const parsed = agentDefSchema.parse(def) as AgentDef;
  if (!isValidSlug(parsed.slug)) {
    throw new Error(
      `invalid agent slug: "${parsed.slug}" — use lowercase letters, digits, and single hyphens`,
    );
  }
  await fs.mkdir(agentsDir(conceptionPath), { recursive: true });
  const file = join(agentsDir(conceptionPath), `${parsed.slug}.json`);
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  if (previousSlug && previousSlug !== parsed.slug) {
    await deleteAgent(conceptionPath, previousSlug);
  }
  return parsed.slug;
}

/** Delete an agent definition file by slug. No-op when already absent. */
export async function deleteAgent(conceptionPath: string, slug: string): Promise<void> {
  try {
    await fs.unlink(join(agentsDir(conceptionPath), `${safePathStem(slug)}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Resolve an agent into a runnable spawn spec, with the real token injected
 * from `agents/.env`. Throws `MissingAgentSecretError` (from buildSpawn) when a
 * declared secret is unresolved, and a plain error when the agent is unknown.
 */
export async function resolveAgentSpawn(conceptionPath: string, slug: string): Promise<SpawnSpec> {
  const def = await readAgent(conceptionPath, slug);
  if (!def) throw new Error(`unknown agent: ${slug}`);
  const env = await readEnv(conceptionPath);
  const spec = buildSpawn(def, (key) => env[key] || undefined);
  // kimi: inject instructions at spawn by wrapping the plain instructions file
  // (default ~/.kimi/AGENTS.md) into a transient `--agent-file` YAML.
  if (def.harness === 'kimi' && def.config.instructionsFile?.trim()) {
    const agentFile = await generateKimiAgentFile(def.config.instructionsFile, def.slug);
    if (agentFile) spec.args = ['--agent-file', agentFile, ...spec.args];
  }
  return spec;
}

/** Read the plain kimi instructions file and write a transient agent-file YAML
 *  to the OS temp dir, returning its path. Returns null when the instructions
 *  file is absent (kimi then falls back to its own defaults). */
async function generateKimiAgentFile(
  instructionsFile: string,
  slug: string,
): Promise<string | null> {
  const expanded = instructionsFile.startsWith('~/')
    ? join(homedir(), instructionsFile.slice(2))
    : instructionsFile;
  let instructions: string;
  try {
    instructions = await fs.readFile(expanded, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const out = join(tmpdir(), `condash-kimi-${slug.replace(/[^A-Za-z0-9._-]/g, '_')}.agent.yaml`);
  await fs.writeFile(out, kimiAgentFileYaml(instructions), 'utf8');
  return out;
}

/**
 * Spawn preview for the pane's "view full config". Auth vars show a
 * `$SECRET_ENV` reference rather than any real value, so it never leaks a token
 * and never throws on an absent one.
 */
export async function previewAgent(
  conceptionPath: string,
  slug: string,
): Promise<AgentSpawnPreview | null> {
  const def = await readAgent(conceptionPath, slug);
  if (!def) return null;
  const spec = buildSpawn(def, (key) => `$${key}`);
  return { command: spec.command, args: spec.args, env: spec.env, unsetEnv: spec.unsetEnv };
}
