import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { posixSingleQuote } from '../shared/shell-quote';

const execFileAsync = promisify(execFile);

/**
 * Login-shell PATH resolution.
 *
 * GUI-launched Electron (a Wayland session, the macOS Dock, a `.desktop`
 * entry) never sources the user's login dotfiles, so `process.env.PATH` is
 * missing anything the user added in `~/.profile` / `~/.zprofile` /
 * `~/.bash_profile`. Every pty or child process condash spawns then inherits
 * that truncated PATH and can't find user-installed CLIs (`opencode`, the
 * `~/bin` wrappers, …).
 *
 * We spawn the user's `$SHELL` once as a login + interactive shell, capture
 * the PATH it exports, and cache it for the process lifetime — the same trick
 * VS Code uses for its integrated terminal. PATH only: every other variable is
 * left to condash's existing spawn-env handling, so the AppImage env-hygiene
 * scrub (see docs/explanation/internals.md#environment-hygiene) is untouched.
 */

/** Hard cap on the probe shell. A hung rc-file must not block app startup or
 * the first terminal spawn; on timeout we fall back to the inherited PATH. */
const RESOLVE_TIMEOUT_MS = 5000;

/** node-as-electron stdout can include rc-file banners / MOTD before our
 * payload, so the probe brackets the JSON env dump with a random marker we
 * slice back out. */
type ShellRunner = (shell: string, args: string[]) => Promise<{ stdout: string }>;

/**
 * Build the argv for the probe shell. Runs the Electron binary as plain Node
 * (`ELECTRON_RUN_AS_NODE`, set by the caller) to print the resolved env as
 * JSON between two markers — JSON.stringify handles every escaping concern
 * that a raw `echo $PATH` would not.
 */
export function buildProbeArgs(execPath: string, marker: string): string[] {
  const inner = `process.stdout.write(${JSON.stringify(marker)}+JSON.stringify(process.env)+${JSON.stringify(marker)})`;
  // The probe is always a POSIX shell (resolveLoginPath bails on win32), so
  // POSIX single-quoting from the shared shell-quote module is the right form.
  const command = `${posixSingleQuote(execPath)} -e ${posixSingleQuote(inner)}`;
  // -l login (sources ~/.profile etc.), -i interactive (sources ~/.bashrc /
  // ~/.zshrc), -c run-and-exit. Together they capture both the login and the
  // interactive contributions to PATH regardless of where the user put it.
  return ['-l', '-i', '-c', command];
}

/**
 * Pull the JSON env object out of probe stdout. Returns null when the markers
 * are absent (probe failed before printing) or the slice isn't valid JSON.
 */
export function parseMarkedEnv(
  stdout: string,
  marker: string,
): Record<string, string | undefined> | null {
  const first = stdout.indexOf(marker);
  if (first === -1) return null;
  const start = first + marker.length;
  const end = stdout.indexOf(marker, start);
  if (end === -1) return null;
  try {
    return JSON.parse(stdout.slice(start, end)) as Record<string, string | undefined>;
  } catch {
    return null;
  }
}

async function defaultRun(shell: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(shell, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: RESOLVE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8',
  });
  return { stdout };
}

/**
 * Resolve the PATH a user login shell exports. Returns null on Windows, on any
 * spawn / parse failure, or when the resolved env carries no PATH — callers
 * then keep the inherited `process.env.PATH`. The `run` seam is injected by
 * tests; production uses the real shell.
 */
export async function resolveLoginPath(run: ShellRunner = defaultRun): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/bash';
  const marker = randomBytes(16).toString('hex');
  try {
    const { stdout } = await run(shell, buildProbeArgs(process.execPath, marker));
    const env = parseMarkedEnv(stdout, marker);
    return env?.PATH ?? null;
  } catch {
    return null;
  }
}

let cached: Promise<string | null> | null = null;

/** Cached `resolveLoginPath()` — runs the probe at most once per process. */
export function loginPath(): Promise<string | null> {
  if (!cached) cached = resolveLoginPath();
  return cached;
}

/**
 * Return a copy of `base` with PATH replaced by `path` when `path` is
 * non-null; otherwise `base` is copied through unchanged. Pure — never mutates
 * `base`.
 */
export function withPath(base: NodeJS.ProcessEnv, path: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (path) env.PATH = path;
  return env;
}

/**
 * The base environment for a condash-spawned child: a copy of `process.env`
 * with PATH replaced by the resolved login PATH when available. Callers layer
 * their own keys (e.g. `TERM`) and scrubs on top of the returned object.
 */
export async function spawnEnv(): Promise<NodeJS.ProcessEnv> {
  return withPath(process.env, await loginPath());
}

/** Test-only: drop the memoised probe result so each case resolves fresh. */
export function resetLoginPathCache(): void {
  cached = null;
}
