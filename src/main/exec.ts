import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { armSpawnDeadline } from './spawn-deadline';

const execFileAsync = promisify(execFile);

/** 10 MB — comfortably above any porcelain / log output we read. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
/** Generous default so a wedged subprocess can't hang the GUI forever.
 *  Call sites that legitimately run long (e.g. the per-repo `install:`
 *  command in worktree setup) override with `timeout: 0`. */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ExecOptions extends ExecFileOptions {
  /** Hard deadline enforced from a worker thread (see spawn-deadline.ts):
   *  the child is killed `spawnDeadlineMs` after its spawn even when the
   *  main event loop is too blocked to run `execFile`'s own JS timeout
   *  timer. The internal `timeout` stays as a backstop. Intended for
   *  UI-triggered network lookups (`gh`) whose cap must hold under load. */
  spawnDeadlineMs?: number;
}

/**
 * Promisified `execFile` with house defaults. Was a bare
 * `promisify(execFile)` duplicated four times across `main/audit.ts`,
 * `main/worktrees.ts`, `main/worktree-ops.ts`, and `cli/commands/projects.ts`;
 * centralised here so the import site is grep-friendly and the defaults stay
 * aligned: no shell, 10 MB `maxBuffer`, 60 s `timeout` (both overridable
 * per call). For git invocations, `GIT_TERMINAL_PROMPT=0` is set unless the
 * caller's env already carries it, so a credential prompt fails fast instead
 * of hanging a background lookup, and `LC_ALL=C` is forced so git's stderr is
 * always English — error classification pattern-matches on message text and
 * must not break under a localized git.
 */
export async function exec(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (file === 'git') {
    if (env.GIT_TERMINAL_PROMPT === undefined) {
      env.GIT_TERMINAL_PROMPT = '0';
    }
    env.LC_ALL = 'C';
  }
  const { spawnDeadlineMs, ...rest } = options;
  const merged = {
    maxBuffer: DEFAULT_MAX_BUFFER,
    timeout: DEFAULT_TIMEOUT_MS,
    ...rest,
    env,
    encoding: 'utf8' as const,
  };
  if (spawnDeadlineMs === undefined) {
    return execFileAsync(file, [...args], merged);
  }
  // Deadline path: the callback form exposes the child pid, which the
  // worker-thread deadline arms against. execFile's own `timeout` stays in
  // `merged` as a backstop for a deadline-worker spawn failure.
  return new Promise((resolve, reject) => {
    let disarm = (): void => {};
    const child = execFile(file, [...args], merged, (error, stdout, stderr) => {
      disarm();
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    if (child.pid != null) disarm = armSpawnDeadline(child.pid, spawnDeadlineMs);
  });
}
