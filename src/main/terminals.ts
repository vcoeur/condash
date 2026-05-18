import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import * as pty from 'node-pty';
import type { TermSession, TermSide, TermSpawnRequest, TerminalPrefs } from '../shared/types';
import { atomicWrite } from './atomic-write';
import { findRepoEntry, type ConfigShape } from './config-walk';
import { getEffectiveConceptionConfig } from './effective-config';
import { readSettings, updateSettings } from './settings';
import { tokenise } from './launchers';
import { SessionLogger } from './terminal-logger';

interface Session {
  id: string;
  side: TermSide;
  /** Live pty handle. Set to null after the process exits — the session row
   * lingers (with `exited` populated) until the renderer explicitly closes it. */
  pty: pty.IPty | null;
  webContents: WebContents;
  /** Optional repo this session was spawned for (Run button). */
  repo?: string;
  /** Resolved cwd of the spawned pty. Surfaced in the broadcast snapshot
   * so the Code pane can match a session to the worktree it was started in. */
  cwd: string;
  /** Captured at spawn time so Stop doesn't need conceptionPath at kill time. */
  forceStop?: string;
  /** Rolling tail of stdout/stderr — replayed when a freshly-loaded renderer
   * re-attaches via termAttach. Capped at MAX_BUFFER bytes. */
  buffer: string;
  /** Process exit code; undefined while live. */
  exited?: number;
  /** Per-session 'destroyed' listener handle on `webContents` — kept on the
   * session so `stopSession` can remove it (otherwise long-lived renderers
   * accumulate one stale closure per spawned-and-closed session). */
  onWebContentsDestroyed?: () => void;
  /** Per-session disk logger — captures stdin / stdout / spawn / exit to
   * `.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.jsonl`. Null when the spawn
   * happened without an active conception (no place to write). */
  logger: SessionLogger | null;
}

const MAX_BUFFER = 64_000;
const sessions = new Map<string, Session>();

function appendBuffer(session: Session, data: string): void {
  session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
}

function snapshot(): TermSession[] {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    side: s.side,
    repo: s.repo,
    cwd: s.cwd,
    exited: s.exited,
  }));
}

function broadcastSessions(): void {
  const snap = snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents.isDestroyed()) continue;
    win.webContents.send('termSessions', snap);
  }
}

export function listTerminalSessions(): TermSession[] {
  return snapshot();
}

export function attachTerminal(
  id: string,
  sender: WebContents,
): { output: string; exited?: number } | null {
  const s = sessions.get(id);
  if (!s) return null;
  // Reassign the live data sink to the calling renderer so that subsequent
  // `termData` events from the still-running pty land in the freshly-loaded
  // window. Without this, after a renderer reload the session row is visible
  // but no live output arrives — `webContents.send` keeps targeting the
  // destroyed original WebContents and silently bails.
  if (!s.webContents.isDestroyed() && s.webContents.id === sender.id) {
    return { output: s.buffer, exited: s.exited };
  }
  if (s.onWebContentsDestroyed) {
    try {
      s.webContents.removeListener('destroyed', s.onWebContentsDestroyed);
    } catch {
      /* old webContents already gone */
    }
  }
  s.webContents = sender;
  const onDestroyed = (): void => {
    void closeSession(id);
  };
  s.onWebContentsDestroyed = onDestroyed;
  sender.once('destroyed', onDestroyed);
  return { output: s.buffer, exited: s.exited };
}

/** Move a session between the "my" and "code" sides. Used by the Code pane's
 * pop-out button to surface a running dev server in the bottom pane. */
export function setSessionSide(id: string, side: TermSide): void {
  const s = sessions.get(id);
  if (!s || s.side === side) return;
  s.side = side;
  broadcastSessions();
}

/** Generate an opaque session id. The 8-hex-char random suffix is
 * filename-safe (used in the log writer's path) and unique across
 * restarts / windows — the previous monotonic counter collided with
 * filenames after a crash + restart in the same second. */
function makeId(): string {
  return `t-${randomBytes(4).toString('hex')}`;
}

async function readRawConfig(conceptionPath: string): Promise<ConfigShape> {
  return (await getEffectiveConceptionConfig(conceptionPath)) as ConfigShape;
}

function defaultShell(configured?: string): string {
  if (configured && configured.trim()) return configured;
  // SHELL is reliably set on POSIX. On Windows it is usually unset; fall
  // through to ComSpec, then cmd.exe.
  if (process.platform !== 'win32' && process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return '/bin/bash';
}

/** Build the argv for running `command` through `shell`. POSIX shells take
 *  `-l -c <cmd>`; cmd.exe needs `/d /s /c <cmd>`; PowerShell needs
 *  `-NoLogo -NonInteractive -Command <cmd>`. We detect by the basename of
 *  the shell binary so a user-configured `pwsh.exe` or `git-bash.exe` is
 *  routed correctly. */
function wrapForShell(shell: string, command: string): string[] {
  const name = basename(shell).toLowerCase();
  if (process.platform === 'win32') {
    if (name === 'cmd.exe' || name === 'cmd') {
      return ['/d', '/s', '/c', command];
    }
    if (
      name === 'powershell.exe' ||
      name === 'powershell' ||
      name === 'pwsh.exe' ||
      name === 'pwsh'
    ) {
      return ['-NoLogo', '-NonInteractive', '-Command', command];
    }
    // Fall through for bash on Git-for-Windows et al.
    return ['-c', command];
  }
  // Non-login shell on POSIX: a login shell would re-source ~/.profile and
  // re-set PYTHONHOME/PYTHONPATH/PERLLIB/etc., undoing the env-scrub the
  // pty spawn already applied. Users who want login behaviour can prefix
  // their `run:` field with `bash -lc` themselves.
  return ['-c', command];
}

export async function spawnTerminal(
  conceptionPath: string | null,
  webContents: WebContents,
  request: TermSpawnRequest,
): Promise<{ id: string; cwd: string }> {
  const config = conceptionPath ? await readRawConfig(conceptionPath) : {};
  const settings = await readSettings();
  const shell = defaultShell(settings.terminal?.shell);

  let cwd = request.cwd ?? homedir();
  let argv: string[] = [];
  let program = shell;
  let forceStop: string | undefined;

  if (request.repo && conceptionPath) {
    const entry = findRepoEntry(config, request.repo);
    if (!entry) throw new Error(`Repo '${request.repo}' not found in effective config`);
    // Honour an explicit request.cwd (worktree path from the Code-pane Run
    // button on a non-primary branch) over the entry's resolved primary
    // checkout. Without this, every Run lands on the primary checkout
    // regardless of which branch row the user clicked.
    if (!request.cwd && entry.cwd) cwd = entry.cwd;
    // Wrap the configured run: command for the active shell so user-supplied
    // shells like `make dev && tail -f log` keep their pipes / && / operators
    // on every OS (POSIX -lc / cmd.exe /d /s /c / pwsh -Command).
    if (entry.run) {
      program = shell;
      argv = wrapForShell(shell, entry.run);
    }
    forceStop = entry.forceStop;
  } else if (request.command) {
    program = shell;
    argv = wrapForShell(shell, request.command);
  }

  // One run per repo: kill any prior code-side session for the same repo
  // before we spawn. Awaited so renderer reactions stay clean
  // (termSessions snapshot drops the old entry first, then we add the new
  // one), and so the dev port is freed before the new run binds.
  if (request.side === 'code' && request.repo) {
    const stale = [...sessions.values()].filter(
      (s) => s.side === 'code' && s.repo === request.repo,
    );
    await Promise.all(stale.map((s) => stopSession(s.id)));
  }

  const cols = request.cols ?? 80;
  const rows = request.rows ?? 24;

  // Electron itself runs through whatever shell the user launched it from,
  // which on systems with a global npm install at /usr/local sets
  // `npm_config_prefix=/usr/local` in the env. nvm refuses to load when that
  // is set ("nvm is not compatible with the npm_config_prefix environment
  // variable"), so user shells spawned here would dump that error on every
  // boot. Strip the npm-cli leakage so spawned shells start clean.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' };
  delete childEnv.npm_config_prefix;
  delete childEnv.npm_config_globalconfig;
  delete childEnv.npm_config_userconfig;

  const ptyProcess = pty.spawn(program, argv, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: childEnv,
  });

  const id = makeId();
  const logger = conceptionPath
    ? new SessionLogger(
        conceptionPath,
        {
          sid: id,
          side: request.side,
          repo: request.repo,
          cwd,
          spawn: { cmd: program, argv },
        },
        config.terminal?.logging,
      )
    : null;
  const session: Session = {
    id,
    side: request.side,
    pty: ptyProcess,
    webContents,
    repo: request.repo,
    cwd,
    forceStop,
    buffer: '',
    logger,
  };
  sessions.set(id, session);
  logger?.spawn();

  ptyProcess.onData((data) => {
    appendBuffer(session, data);
    session.logger?.output(data);
    if (webContents.isDestroyed()) return;
    webContents.send('termData', { id, data });
  });
  ptyProcess.onExit(({ exitCode }) => {
    session.exited = exitCode;
    session.pty = null;
    session.logger?.exit(exitCode);
    if (!webContents.isDestroyed()) {
      webContents.send('termExit', { id, code: exitCode });
    }
    // Keep the entry around (with `exited` set) so renderers that reload
    // can still see it via termList — closeSession removes it on demand.
    broadcastSessions();
  });

  const onDestroyed = (): void => {
    void closeSession(id);
  };
  session.onWebContentsDestroyed = onDestroyed;
  webContents.once('destroyed', onDestroyed);

  broadcastSessions();
  return { id, cwd };
}

export function writeTerminal(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session?.pty) return;
  session.logger?.input(data);
  session.pty.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session?.pty) return;
  try {
    session.pty.resize(Math.max(1, cols), Math.max(1, rows));
  } catch {
    /* the pty may have just exited */
  }
}

/** Send SIGTERM to the pty's process group. node-pty allocates a session
 * leader (setsid), so the negative pid form reaches the wrapping shell AND
 * everything it spawned (e.g. `make dev` → `vite` → child workers). The
 * unix-only sentinel `-pid` form is portable across linux/macOS; on Windows,
 * node-pty manages termination via a different code path inside `pty.kill()`,
 * so we fall back to that there. */
function killTree(p: pty.IPty | null, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!p) return;
  if (process.platform === 'win32') {
    try {
      p.kill();
    } catch {
      /* gone */
    }
    return;
  }
  try {
    process.kill(-p.pid, signal);
  } catch {
    /* gone */
  }
}

function isAlive(p: pty.IPty | null): boolean {
  if (!p) return false;
  if (process.platform === 'win32') return true;
  try {
    process.kill(-p.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Cap for how long stopSession will wait for force_stop to settle before
 * moving on to the SIGKILL grace period. The detached child is unref'd at
 * spawn time so the main process exit isn't blocked; this timeout just
 * unblocks the awaiter so a slow / hung force_stop script can't stall the
 * tab-close path. */
const FORCE_STOP_TIMEOUT_MS = 3000;

function runForceStop(command: string): Promise<void> {
  // Tokenise + shell:false to mirror launchers.runForceStopRepo. Routing
  // the user-configured force_stop: string through the shell costs us
  // shell-metacharacter surprises (stray `&`, unintended globs) and ${VAR}
  // interpolation against the main-process env — the argv shape avoids
  // both. Pass-9 closes the parity gap with launchers.ts.
  return new Promise<void>((resolve) => {
    const argv = tokenise(command, '');
    if (argv.length === 0) {
      resolve();
      return;
    }
    const [program, ...args] = argv;
    const child = spawn(program, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    // Detach the child from the main process event loop so a script that
    // outlives the kill path (intentional or hung) doesn't hold the awaiter
    // open beyond the timeout.
    child.unref();
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, FORCE_STOP_TIMEOUT_MS);
    child.on('error', finish);
    child.on('exit', finish);
  });
}

interface StopOpts {
  /** Run the configured force_stop: command after SIGTERM. Default true. */
  runForceStop?: boolean;
  /** Remove the session entry from the map and broadcast. Default true. The
   * killAll path passes false so it can clear the map in one shot. */
  removeEntry?: boolean;
}

/** Terminate a session's process tree via the parity-batch-7 pipeline:
 * SIGTERM the process group → run force_stop: → SIGKILL fallback after a
 * 500 ms grace if the leader is still alive. Resolves once the kill is
 * issued — does not wait for the pty's onExit callback. */
async function stopSession(id: string, opts: StopOpts = {}): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  const runFs = opts.runForceStop !== false;
  const removeEntry = opts.removeEntry !== false;

  const p = session.pty;
  killTree(p, 'SIGTERM');

  if (runFs && session.forceStop) {
    try {
      await runForceStop(session.forceStop);
    } catch {
      /* surfaced via toast at the renderer; don't block the kill */
    }
  }

  if (isAlive(p)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    // Re-check session state before SIGKILL: if the original pty exited
    // during the 500 ms grace and the OS recycled its PID for another
    // process, killTree(p, 'SIGKILL') would target the foreign group.
    // Bail out unless the same pty handle is still tracked.
    const stillSamePty = session.pty?.pid === p?.pid && session.exited === undefined;
    if (stillSamePty && isAlive(p)) killTree(p, 'SIGKILL');
  }

  if (removeEntry) {
    if (session.onWebContentsDestroyed && !session.webContents.isDestroyed()) {
      try {
        session.webContents.removeListener('destroyed', session.onWebContentsDestroyed);
      } catch {
        /* webContents already torn down */
      }
    }
    // Flush + close the log file. close() is idempotent so the killAll
    // path's two-stage tear-down (delete after Promise.allSettled) doesn't
    // double-close.
    if (session.logger) {
      void session.logger.close();
    }
    sessions.delete(id);
    broadcastSessions();
  }
}

export function closeSession(id: string): Promise<void> {
  return stopSession(id);
}

/** Read effective terminal prefs. The active conception's `condash.json`
 * may override the entire `terminal` block (top-level replace); when no
 * override is set, the per-machine `settings.json` value applies. The
 * one-shot migration that promoted terminal from configuration.json into
 * settings.json (2026-05-01) still runs at boot — the overridable layer
 * sits on top of that. */
export async function getTerminalPrefs(): Promise<TerminalPrefs> {
  const settings = await readSettings();
  if (settings.lastConceptionPath) {
    const effective = await getEffectiveConceptionConfig(settings.lastConceptionPath);
    if (effective.terminal) return effective.terminal;
  }
  return settings.terminal ?? {};
}

/** Replace the persisted terminal prefs in settings.json. The patch is a
 * full replacement; pass `{}` to clear back to defaults. Always writes to
 * the per-machine settings.json — per-conception overrides are written
 * via the Settings modal's `patchConfig` flow. */
export async function setTerminalPrefs(patch: TerminalPrefs): Promise<void> {
  await updateSettings((cur) => ({ ...cur, terminal: patch }));
}

/** One-shot migration: if settings.json has no terminal block but the
 * pre-existing configuration.json carries one, copy it over and strip
 * configuration.json. Idempotent — does nothing once settings.json owns
 * the data. */
export async function migrateTerminalFromConfigIfNeeded(): Promise<void> {
  // Initial read is just a fast-path bail; the authoritative check repeats
  // inside updateSettings's mutator so concurrent setTheme/setLayout IPC
  // can't race with this migration.
  const initial = await readSettings();
  if (initial.terminal && Object.keys(initial.terminal).length > 0) return;
  if (!initial.lastConceptionPath) return;
  // Legacy migration: only the original `configuration.json` is checked.
  // A fresh `condash.json` carrying a terminal block is a deliberate
  // per-conception override and stays put.
  const configFile = join(initial.lastConceptionPath, 'configuration.json');
  let raw: string;
  try {
    raw = await fs.readFile(configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const legacy = parsed.terminal as TerminalPrefs | undefined;
  if (!legacy || Object.keys(legacy).length === 0) return;
  // Atomic read-modify-write: skip the merge if cur.terminal is already
  // populated (a concurrent IPC may have written it between the initial
  // read and the queue head).
  let migrated = false;
  await updateSettings((cur) => {
    if (cur.terminal && Object.keys(cur.terminal).length > 0) return cur;
    migrated = true;
    return { ...cur, terminal: legacy };
  });
  if (!migrated) return;
  delete parsed.terminal;
  const next = JSON.stringify(parsed, null, 2) + '\n';
  await atomicWrite(configFile, next);
}

/** Kill every session (or every session attached to `forWebContents`) via the
 * full Stop pipeline — process-group SIGTERM, force_stop if configured,
 * SIGKILL fallback. Bounded to ~1 s aggregate so the window can actually
 * close even if one repo's force_stop hangs. */
export async function killAll(forWebContents?: WebContents): Promise<void> {
  const targets = [...sessions.entries()].filter(
    ([, s]) => !forWebContents || s.webContents === forWebContents,
  );
  if (targets.length === 0) return;

  const stops = targets.map(([id]) => stopSession(id, { removeEntry: false }));
  await Promise.race([
    Promise.allSettled(stops),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

  for (const [id] of targets) sessions.delete(id);
  broadcastSessions();
}
