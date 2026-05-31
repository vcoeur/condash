/**
 * Segregated task-run console logs (capabilities 1 + 4).
 *
 * Task runs that opt out of the normal logs — every `scheduled` run, and a
 * `manual` run of a task flagged `excludeFromLogs` — write their console
 * output here instead of `.condash/logs/`:
 *
 *   <conception>/.condash/<trigger>/<task-slug>/<YYYYMMDD>-<HHMMSS>-<sid>.txt
 *
 * `trigger` ∈ {scheduled, manual}. Files reuse the session `.txt` format (a
 * `# condash:` header line + rendered body) so the existing logs-modal viewer
 * and `splitContent` readers work unchanged. The dirs are **never** under
 * `.condash/logs/`, so `logs-reports`, the normal Logs list, and `work-overview`
 * never see them. The Logs pane's "Task runs" view browses this store.
 *
 * Retention: last ~5 runs per `<trigger>/<slug>` dir, oldest pruned.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { isValidSlugTail } from '../shared/slug';
import type { TaskRunEntry, TaskRunGroup, TaskTrigger } from '../shared/types';
import { condashDir } from './condash-dir';

export const TASK_TRIGGERS: readonly TaskTrigger[] = ['scheduled', 'manual'];

/** Keep at most this many run files per `<trigger>/<slug>` dir. */
export const TASK_RUN_KEEP = 5;

/** Absolute path to `<conception>/.condash/<trigger>/<slug>/`. */
export function taskRunDir(conception: string, trigger: TaskTrigger, slug: string): string {
  return join(condashDir(conception), trigger, slug);
}

/** Build the run-file path for one spawn. Filename `YYYYMMDD-HHMMSS-<sid>.txt`
 *  carries its own date so a flat per-slug dir stays sortable. */
export function taskRunLogPath(
  conception: string,
  trigger: TaskTrigger,
  slug: string,
  sid: string,
  when: Date = new Date(),
): string {
  const yyyy = String(when.getFullYear());
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  const dd = String(when.getDate()).padStart(2, '0');
  const hh = String(when.getHours()).padStart(2, '0');
  const mi = String(when.getMinutes()).padStart(2, '0');
  const ss = String(when.getSeconds()).padStart(2, '0');
  return join(
    taskRunDir(conception, trigger, slug),
    `${yyyy}${mm}${dd}-${hh}${mi}${ss}-${sid}.txt`,
  );
}

const RUN_FILE_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.txt$/;

/** Parse a run filename into its entry fields, or null when it doesn't match. */
function parseRunFile(dir: string, name: string, bytes: number): TaskRunEntry | null {
  const m = RUN_FILE_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, sid] = m;
  return {
    path: join(dir, name),
    day: `${y}-${mo}-${d}`,
    time: `${hh}:${mi}:${ss}`,
    sid,
    bytes,
  };
}

async function readDirSafe(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Prune a `<trigger>/<slug>` dir down to the newest `keep` run files. Called
 * after a new run file is created. Best-effort — swallows fs errors so a
 * rotation failure never blocks a spawn.
 */
export async function rotateTaskRuns(dir: string, keep: number = TASK_RUN_KEEP): Promise<void> {
  try {
    const names = (await readDirSafe(dir)).filter((n) => RUN_FILE_RE.test(n));
    // Filenames sort lexicographically === chronologically (zero-padded
    // YYYYMMDD-HHMMSS prefix). Newest last; drop everything before the tail.
    names.sort();
    const excess = names.length - keep;
    for (let i = 0; i < excess; i++) {
      await fs.rm(join(dir, names[i]), { force: true }).catch(() => undefined);
    }
  } catch {
    /* rotation is best-effort */
  }
}

/**
 * Enumerate every segregated task run under `.condash/scheduled/*` and
 * `.condash/manual/*`. Returns one group per `<trigger>/<slug>`, runs
 * newest-first, groups sorted by slug then trigger. Empty when nothing exists.
 */
export async function listTaskRuns(conception: string): Promise<TaskRunGroup[]> {
  const groups: TaskRunGroup[] = [];
  for (const trigger of TASK_TRIGGERS) {
    const triggerRoot = join(condashDir(conception), trigger);
    const slugs = await readDirSafe(triggerRoot);
    for (const slug of slugs) {
      if (!isValidSlugTail(slug)) continue;
      const dir = join(triggerRoot, slug);
      const names = await readDirSafe(dir);
      const runs: TaskRunEntry[] = [];
      for (const name of names) {
        if (!RUN_FILE_RE.test(name)) continue;
        let bytes = 0;
        try {
          bytes = (await fs.stat(join(dir, name))).size;
        } catch {
          continue;
        }
        const entry = parseRunFile(dir, name, bytes);
        if (entry) runs.push(entry);
      }
      if (runs.length === 0) continue;
      runs.sort((a, b) => (a.path < b.path ? 1 : -1));
      groups.push({ taskSlug: slug, trigger, runs });
    }
  }
  groups.sort((a, b) => a.taskSlug.localeCompare(b.taskSlug) || a.trigger.localeCompare(b.trigger));
  return groups;
}

/** True when `path` is a `.txt` inside one of this conception's task-run
 *  dirs. Used by the Logs IPC to bound `logsReadSession` reads to the
 *  segregated store as well as the normal logs root. */
export function isTaskRunPath(conception: string, path: string): boolean {
  if (!path.endsWith('.txt')) return false;
  for (const trigger of TASK_TRIGGERS) {
    const root = join(condashDir(conception), trigger);
    if (path === root) continue;
    if (path.startsWith(root + '/') || path.startsWith(root + '\\')) return true;
  }
  return false;
}
