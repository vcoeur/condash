/**
 * Per-shell-family quoting and command wrapping — the single home for "fold
 * this text into a shell command line safely".
 *
 * Pure and dependency-free (no `node:` imports) so the renderer can share it:
 * the renderer-side task runner (`terminal-bridge.ts`), the headless task
 * scheduler (`task-scheduler.ts`), the pty spawner (`terminals.ts`), and the
 * login-PATH probe (`shell-env.ts`) all quote/wrap through here. It replaced
 * three divergent private `shellSingleQuote` copies that applied POSIX quoting
 * regardless of the target shell — on Windows that let `&` / `|` / `%VAR%`
 * inside a prompt execute under `cmd.exe /d /s /c`.
 */

/** The three quoting/wrapping dialects condash distinguishes. Detection is by
 *  shell binary basename, not platform — a `pwsh` configured on Linux gets
 *  PowerShell semantics, a Git-for-Windows `bash.exe` gets POSIX. */
export type ShellFamily = 'posix' | 'cmd' | 'powershell';

const CMD_NAMES: ReadonlySet<string> = new Set(['cmd', 'cmd.exe']);
const POWERSHELL_NAMES: ReadonlySet<string> = new Set([
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

/**
 * Classify a shell into its quoting/wrapping family by binary basename.
 *
 * @param shell Configured shell path/name; blank or undefined falls back to
 *   the platform default (`cmd` on Windows, POSIX elsewhere).
 * @param isWindows Whether the resolver runs for a Windows host — only used
 *   for the blank-shell fallback.
 * @returns The matched family; any unrecognised name is treated as POSIX.
 */
export function shellFamily(shell: string | undefined, isWindows: boolean): ShellFamily {
  const trimmed = shell?.trim() ?? '';
  if (trimmed === '') return isWindows ? 'cmd' : 'posix';
  const name = trimmed.split(/[\\/]/).pop()!.toLowerCase();
  if (CMD_NAMES.has(name)) return 'cmd';
  if (POWERSHELL_NAMES.has(name)) return 'powershell';
  return 'posix';
}

/**
 * Build the argv for running `command` through a shell of `family`: POSIX
 * shells take `-c <cmd>`, cmd.exe `/d /s /c <cmd>`, PowerShell
 * `-NoLogo -NonInteractive -Command <cmd>`.
 *
 * POSIX deliberately uses a non-login shell: a login shell would re-source
 * `~/.profile` and re-set PYTHONHOME/PYTHONPATH/PERLLIB/etc., undoing the
 * env-scrub the pty spawn already applied. The login-shell PATH is injected
 * via `spawnEnv()` instead; users who want full login behaviour can prefix
 * their command with `bash -lc`.
 */
export function shellCommandArgv(family: ShellFamily, command: string): string[] {
  if (family === 'cmd') return ['/d', '/s', '/c', command];
  if (family === 'powershell') return ['-NoLogo', '-NonInteractive', '-Command', command];
  return ['-c', command];
}

/**
 * Quote `text` so it survives the `family` shell's command line as one literal
 * argument — quotes, `&`, `|`, `%VAR%`, `$VAR`, and (except under cmd.exe)
 * newlines all arrive verbatim in the child's argv.
 *
 * @param text Arbitrary text (typically a substituted prompt).
 * @param family Target shell family — must match the shell the composed
 *   command string will actually be wrapped with (`shellCommandArgv`).
 */
export function quoteForShell(text: string, family: ShellFamily): string {
  if (family === 'cmd') return cmdQuote(text);
  if (family === 'powershell') return powershellQuote(text);
  return posixSingleQuote(text);
}

/** POSIX single-quote: wrap in `'…'`, rewriting each embedded `'` as `'\''`
 *  (close-quote, escaped quote, reopen-quote). Newlines ride through inside
 *  the quotes. */
export function posixSingleQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single-quoted literal: no interpolation inside `'…'`; an
 *  embedded `'` is escaped by doubling. Newlines ride through. */
function powershellQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * cmd.exe quoting, the cross-spawn recipe: (1) quote for the child's C runtime
 * (double any backslash run before a `"`, escape the `"` itself, double a
 * trailing backslash run, wrap in `"…"`), then (2) caret-escape every cmd
 * metacharacter so cmd's own parser passes the line through untouched. `%` is
 * caret-escaped too: expansion happens before caret removal, so the caret
 * corrupts the would-be variable name (`%PATH^%` resolves nothing) and caret
 * removal then restores the literal `%`.
 *
 * Limitation: cmd.exe cannot carry a literal newline inside a command-line
 * argument (it terminates the command), so newlines are folded to spaces.
 */
function cmdQuote(text: string): string {
  let quoted = text.replace(/\r?\n/g, ' ');
  quoted = quoted.replace(/(\\*)"/g, '$1$1\\"');
  quoted = quoted.replace(/(\\+)$/, '$1$1');
  quoted = `"${quoted}"`;
  return quoted.replace(/[()%!^"<>&|]/g, '^$&');
}
