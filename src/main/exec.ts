import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 10 MB — comfortably above any porcelain / log output we read. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
/** Generous default so a wedged subprocess can't hang the GUI forever.
 *  Call sites that legitimately run long (e.g. the per-repo `install:`
 *  command in worktree setup) override with `timeout: 0`. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Promisified `execFile` with house defaults. Was a bare
 * `promisify(execFile)` duplicated four times across `main/audit.ts`,
 * `main/worktrees.ts`, `main/worktree-ops.ts`, and `cli/commands/projects.ts`;
 * centralised here so the import site is grep-friendly and the defaults stay
 * aligned: no shell, 10 MB `maxBuffer`, 60 s `timeout` (both overridable
 * per call). For git invocations, `GIT_TERMINAL_PROMPT=0` is set unless the
 * caller's env already carries it, so a credential prompt fails fast instead
 * of hanging a background lookup.
 */
export async function exec(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (file === 'git' && env.GIT_TERMINAL_PROMPT === undefined) {
    env.GIT_TERMINAL_PROMPT = '0';
  }
  return execFileAsync(file, [...args], {
    maxBuffer: DEFAULT_MAX_BUFFER,
    timeout: DEFAULT_TIMEOUT_MS,
    ...options,
    env,
    encoding: 'utf8',
  });
}
