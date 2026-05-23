/**
 * Agent storage + token resolution (main process only).
 *
 * Agents are defined as one JSON file each at
 * `<conception>/agents/<harness>-<model_variant>.json`. The matching API
 * tokens live in a single gitignored `<conception>/agents/.env` of
 * `NAME=value` lines. Secrets are read here and only here — they reach a child
 * process through the spawn environment, never the renderer.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import {
  type AgentDef,
  type AgentListItem,
  type AgentSpawnPreview,
  agentName,
  buildSpawn,
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
  disableCaching: z.boolean(),
  disable1M: z.boolean(),
  disableAdaptiveThinking: z.boolean(),
  disableTelemetry: z.boolean(),
  disableErrorReporting: z.boolean(),
  disableClaudeApiSkill: z.boolean(),
});

const kimiConfigSchema = z.object({ agentFile: z.string() });
const opencodeConfigSchema = z.object({ model: z.string(), disableExternalSkills: z.boolean() });

const agentDefSchema = z.discriminatedUnion('harness', [
  z.object({
    harness: z.literal('claude'),
    modelVariant: z.string().min(1),
    secretEnv: z.string().optional(),
    config: claudeConfigSchema,
  }),
  z.object({
    harness: z.literal('kimi'),
    modelVariant: z.string().min(1),
    secretEnv: z.string().optional(),
    config: kimiConfigSchema,
  }),
  z.object({
    harness: z.literal('opencode'),
    modelVariant: z.string().min(1),
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

/** Reject anything that isn't a bare, safe filename stem (no slashes / `..`). */
function safeName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`invalid agent name: ${name}`);
  }
  return name;
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

async function readDefFromFile(file: string): Promise<AgentDef> {
  const text = await fs.readFile(file, 'utf8');
  return agentDefSchema.parse(JSON.parse(text)) as AgentDef;
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
        name: agentName(def),
        harness: def.harness,
        modelVariant: def.modelVariant,
        secretEnv: def.secretEnv,
        tokenPresent: def.secretEnv ? Boolean(env[def.secretEnv]) : true,
      });
    } catch (err) {
      console.error(`[agents] skipping ${file}: ${(err as Error).message}`);
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/** Read one agent definition by name. `null` when absent. Never includes a token. */
export async function readAgent(conceptionPath: string, name: string): Promise<AgentDef | null> {
  try {
    return await readDefFromFile(join(agentsDir(conceptionPath), `${safeName(name)}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Create or update an agent. The filename is derived from `agentName(def)` so
 * the `<harness>-<model_variant>` convention can't drift. When `previousName`
 * is given and differs from the new name, the old file is removed (rename).
 */
export async function writeAgent(
  conceptionPath: string,
  def: AgentDef,
  previousName?: string,
): Promise<string> {
  const parsed = agentDefSchema.parse(def) as AgentDef;
  const name = agentName(parsed);
  await fs.mkdir(agentsDir(conceptionPath), { recursive: true });
  const file = join(agentsDir(conceptionPath), `${name}.json`);
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  if (previousName && previousName !== name) {
    await deleteAgent(conceptionPath, previousName);
  }
  return name;
}

/** Delete an agent definition file. No-op when already absent. */
export async function deleteAgent(conceptionPath: string, name: string): Promise<void> {
  try {
    await fs.unlink(join(agentsDir(conceptionPath), `${safeName(name)}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Resolve an agent into a runnable spawn spec, with the real token injected
 * from `agents/.env`. Throws `MissingAgentSecretError` (from buildSpawn) when a
 * declared secret is unresolved, and a plain error when the agent is unknown.
 */
export async function resolveAgentSpawn(conceptionPath: string, name: string): Promise<SpawnSpec> {
  const def = await readAgent(conceptionPath, name);
  if (!def) throw new Error(`unknown agent: ${name}`);
  const env = await readEnv(conceptionPath);
  return buildSpawn(def, (key) => env[key] || undefined);
}

/**
 * Spawn preview for the pane's "view full config". Auth vars show a
 * `$SECRET_ENV` reference rather than any real value, so it never leaks a token
 * and never throws on an absent one.
 */
export async function previewAgent(
  conceptionPath: string,
  name: string,
): Promise<AgentSpawnPreview | null> {
  const def = await readAgent(conceptionPath, name);
  if (!def) return null;
  const spec = buildSpawn(def, (key) => `$${key}`);
  return { command: spec.command, args: spec.args, env: spec.env, unsetEnv: spec.unsetEnv };
}
