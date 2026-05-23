/**
 * Task storage (main process only).
 *
 * Tasks live as one directory each at `<conception>/tasks/<slug>/`, holding a
 * `task.json` (`name` / `agent` / `submit`) plus a hand-editable `prompt.md`.
 * This mirrors `agents.ts`: ENOENT-tolerant `listTasks`, derived-filename
 * writes, idempotent delete. The slug is the directory name (regex
 * `^[a-z0-9-]+$`, same family as agents/projects). The referenced `agent` may
 * dangle (renamed/removed) — `listTasks` flags that via `agentPresent` so the
 * pane can warn and disable Run.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { extractMarkers, type TaskDef, type TaskListItem } from '../shared/tasks';
import { isValidSlugTail } from '../shared/slug';
import { listAgents } from './agents';

const TASKS_DIRNAME = 'tasks';
const CONFIG_FILENAME = 'task.json';
const PROMPT_FILENAME = 'prompt.md';

const taskConfigSchema = z.object({
  name: z.string().min(1),
  agent: z.string(),
  submit: z.boolean().optional(),
});

function tasksDir(conceptionPath: string): string {
  return join(conceptionPath, TASKS_DIRNAME);
}

/** Reject anything that isn't a valid slug tail (no slashes / `..` / dots). */
function safeSlug(slug: string): string {
  if (!isValidSlugTail(slug)) throw new Error(`invalid task slug: ${slug}`);
  return slug;
}

/** Read + validate one task directory. Returns `null` when the directory has
 *  no `task.json` (so non-task entries under `tasks/` are skipped, not fatal). */
async function readTaskDir(conceptionPath: string, slug: string): Promise<TaskDef | null> {
  const dir = join(tasksDir(conceptionPath), slug);
  let configText: string;
  try {
    configText = await fs.readFile(join(dir, CONFIG_FILENAME), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const config = taskConfigSchema.parse(JSON.parse(configText));
  let prompt = '';
  try {
    prompt = await fs.readFile(join(dir, PROMPT_FILENAME), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { name: config.name, agent: config.agent, submit: config.submit ?? true, prompt };
}

/**
 * List every valid task under `<conception>/tasks/`, sorted by name. Entries
 * that fail to parse are skipped (warned) rather than failing the whole pane.
 * `agentPresent` reflects whether the referenced agent resolves in
 * `<conception>/agents/`.
 */
export async function listTasks(conceptionPath: string): Promise<TaskListItem[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir(conceptionPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const agentNames = new Set((await listAgents(conceptionPath)).map((a) => a.name));
  const items: TaskListItem[] = [];
  for (const slug of entries) {
    if (!isValidSlugTail(slug)) continue;
    try {
      const def = await readTaskDir(conceptionPath, slug);
      if (!def) continue;
      items.push({
        slug,
        name: def.name,
        agent: def.agent,
        agentPresent: agentNames.has(def.agent),
        markers: extractMarkers(def.prompt),
      });
    } catch (err) {
      console.error(`[tasks] skipping ${slug}: ${(err as Error).message}`);
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/** Read one task by slug. `null` when absent. */
export async function readTask(conceptionPath: string, slug: string): Promise<TaskDef | null> {
  return readTaskDir(conceptionPath, safeSlug(slug));
}

/**
 * Create / update a task. Writes `task.json` + `prompt.md` under
 * `<conception>/tasks/<slug>/`, creating the tree as needed. When
 * `previousSlug` is given and differs, the old directory is removed (rename).
 */
export async function writeTask(
  conceptionPath: string,
  slug: string,
  def: TaskDef,
  previousSlug?: string,
): Promise<string> {
  const safe = safeSlug(slug);
  const config = taskConfigSchema.parse({ name: def.name, agent: def.agent, submit: def.submit });
  const dir = join(tasksDir(conceptionPath), safe);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, CONFIG_FILENAME), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.writeFile(join(dir, PROMPT_FILENAME), def.prompt, 'utf8');
  if (previousSlug && previousSlug !== safe) {
    await deleteTask(conceptionPath, previousSlug);
  }
  return safe;
}

/** Delete a task directory. No-op when already absent. */
export async function deleteTask(conceptionPath: string, slug: string): Promise<void> {
  try {
    await fs.rm(join(tasksDir(conceptionPath), safeSlug(slug)), { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
