/**
 * Task storage (main process only).
 *
 * Tasks live as one directory each at `<conception>/tasks/<slug>/`, holding a
 * `task.json` (`name` / `agent`) plus a hand-editable `prompt.md`.
 * ENOENT-tolerant `listTasks`, derived-filename writes, idempotent delete. The
 * slug is the directory name (regex `^[a-z0-9-]+$`, same family as projects).
 * The referenced `agent` is an agent `id` from the `agents` settings list and
 * may dangle (renamed/removed) — `listTasks` flags that via `agentPresent` so
 * the pane can warn and disable Run.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { extractMarkers, type TaskDef, type TaskListItem } from '../shared/tasks';
import { isValidSlugTail } from '../shared/slug';
import { listAgents } from './agents';
import { atomicWrite } from './atomic-write';

const TASKS_DIRNAME = 'tasks';
const CONFIG_FILENAME = 'task.json';
const PROMPT_FILENAME = 'prompt.md';

/**
 * Validate a `task.json` body without zod. A plain check keeps this module —
 * reachable on the pre-window boot path via `ipc/tasks` (listTasks at boot) and
 * `task-scheduler` — off the eager zod graph (S4). Mirrors the former
 * `z.object({ name: z.string().min(1), agent: z.string() })`: unknown keys are
 * dropped, `name` must be a non-empty string, `agent` a string; a violation
 * throws (the caller in `listTasks` catches + skips, as it did for a ZodError).
 */
function parseTaskConfig(raw: unknown): { name: string; agent: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('task.json: expected an object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length < 1) {
    throw new Error('task.json: `name` must be a non-empty string');
  }
  if (typeof obj.agent !== 'string') {
    throw new Error('task.json: `agent` must be a string');
  }
  return { name: obj.name, agent: obj.agent };
}

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
  const config = parseTaskConfig(JSON.parse(configText));
  let prompt = '';
  try {
    prompt = await fs.readFile(join(dir, PROMPT_FILENAME), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { name: config.name, agent: config.agent, prompt };
}

/**
 * List every valid task under `<conception>/tasks/`, sorted by name. Entries
 * that fail to parse are skipped (warned) rather than failing the whole pane.
 * `agentPresent` reflects whether the referenced agent `id` resolves in the
 * `agents` settings list.
 */
export async function listTasks(conceptionPath: string): Promise<TaskListItem[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir(conceptionPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const agentIds = new Set((await listAgents(conceptionPath)).map((a) => a.id));
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
        agentPresent: agentIds.has(def.agent),
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
 * `previousSlug` is given and differs, the old directory is removed (rename) —
 * but a rename onto a slug that already holds another task is rejected so the
 * write doesn't clobber it before the source is deleted.
 */
export async function writeTask(
  conceptionPath: string,
  slug: string,
  def: TaskDef,
  previousSlug?: string,
): Promise<string> {
  const safe = safeSlug(slug);
  if (previousSlug && previousSlug !== safe && (await readTaskDir(conceptionPath, safe)) !== null) {
    throw new Error(`a task "${safe}" already exists — rename it or pick another slug`);
  }
  const config = parseTaskConfig({ name: def.name, agent: def.agent });
  const dir = join(tasksDir(conceptionPath), safe);
  await fs.mkdir(dir, { recursive: true });
  // Atomic writes: tasks/ sits inside the watched conception tree, where the
  // invariant is tmp → fsync → rename (atomic-write.ts) — a bare writeFile can
  // surface half-written JSON to the watcher or a concurrent listTasks.
  await atomicWrite(join(dir, CONFIG_FILENAME), `${JSON.stringify(config, null, 2)}\n`);
  await atomicWrite(join(dir, PROMPT_FILENAME), def.prompt);
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
