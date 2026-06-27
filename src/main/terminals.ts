import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { BrowserWindow, type WebContents } from 'electron';
import * as pty from 'node-pty';
import type {
  TabInfo,
  TermSession,
  TermSide,
  TermSpawnRequest,
  TerminalPrefs,
} from '../shared/types';
import { EVENT_CHANNELS } from '../shared/ipc-channels';
import { shellCommandArgv, shellFamily } from '../shared/shell-quote';
import { findRepoEntry, type ConfigShape } from './config-walk';
import { getEffectiveConceptionConfig } from './effective-config';
import { readSettings, updateSettings } from './settings';
import { tokenise } from './launchers';
import { spawnEnv } from './shell-env';
import { SessionLogger } from './terminal-logger';
import { cleanTerminalText } from './dashboard/clean-text';
import { OscTranscriptExtractor } from './osc-transcript';
import { readFileTranscript, sidecarTranscriptPath } from './file-transcript';

interface Session {
  id: string;
  side: TermSide;
  /** Live pty handle. Set to null after the process exits — the session row
   * lingers (with `exited` populated) until the renderer explicitly closes it. */
  pty: pty.IPty | null;
  webContents: WebContents;
  /** Optional repo this session was spawned for (Run button). */
  repo?: string;
  /** Human command label for this session (repo `run:`, the free-form
   * command, or the shell). Surfaced in the `{TABS}` provided var so a task
   * can see what each tab is running. */
  cmd?: string;
  /** Cumulative bytes the pty has emitted. Monotonic (unlike `buffer`, which
   * is a capped rolling tail) so the scheduler can growth-gate: skip a run
   * when no tab has produced new output since the last run. */
  bytesSeen: number;
  /** Resolved cwd of the spawned pty. Surfaced in the broadcast snapshot
   * so the Code pane can match a session to the worktree it was started in. */
  cwd: string;
  /** Captured at spawn time so Stop doesn't need conceptionPath at kill time. */
  forceStop?: string;
  /** Rolling tail of stdout/stderr — replayed when a freshly-loaded renderer
   * re-attaches via termAttach. Readers expose only the last ≤ MAX_BUFFER
   * chars (`recentTail`); the stored string may overrun the cap by up to
   * BUFFER_SLACK between reslices (see `appendRecentTail`). */
  buffer: string;
  /** Process exit code; undefined while live. */
  exited?: number;
  /** Per-session 'destroyed' listener handle on `webContents` — kept on the
   * session so `stopSession` can remove it (otherwise long-lived renderers
   * accumulate one stale closure per spawned-and-closed session). */
  onWebContentsDestroyed?: () => void;
  /** Per-session disk logger — renders pty output to a plain-text
   * `.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt` (since v2.27.0; stdin is
   * deliberately not captured — the pty echoes it back through stdout).
   * Null when the spawn happened without an active conception (no place
   * to write). */
  logger: SessionLogger | null;
  /** Always-on in-band transcript capture (OSC 7373), independent of the disk
   * logger and of on-disk logging being enabled. An alternate-screen agent TUI
   * (claude / opencode) leaves its conversation only in this protocol, never in
   * the terminal grid — so the dashboard summarizer reads this when present
   * instead of the repaint-noise raw `buffer`. Stays empty for programs that
   * don't emit the protocol (plain shells, kimi). */
  transcript: OscTranscriptExtractor;
  /** Per-tab neutral sidecar transcript path (`.condash/transcripts/<sid>.ndjson`),
   * passed to the spawned program via `CONDASH_TRANSCRIPT_FILE`. A cooperating
   * program (the agedum claude hook / opencode plugin) appends neutral frames
   * here; the summarizer prefers it over the in-band OSC capture and the raw
   * buffer because a file reliably reaches condash where the program's
   * `/dev/tty` echo does not. Unset when spawned without an active conception
   * (no place to write). */
  transcriptFile?: string;
}

const MAX_BUFFER = 64_000;
/** Reslice hysteresis: the rolling buffer is allowed to overrun MAX_BUFFER by
 *  up to this many chars before the hot append path trims it back to the last
 *  MAX_BUFFER. Without the slack, a high-throughput pty reallocated the whole
 *  (up-to-64 KB) string on every output chunk; with it the reslice happens at
 *  most once per BUFFER_SLACK chars. Readers still expose only the last
 *  ≤ MAX_BUFFER chars via `recentTail`, so observable output is unchanged. */
const BUFFER_SLACK = 16_000;
const sessions = new Map<string, Session>();

/**
 * Append `data` to a rolling-tail buffer, reslicing to the last MAX_BUFFER
 * chars only once the tail overruns MAX_BUFFER + BUFFER_SLACK. Pure (no session
 * state) so the cap behaviour is unit-testable without a live pty.
 *
 * @param tail The current rolling tail.
 * @param data The newly-emitted chunk to append.
 * @returns The new tail — at most MAX_BUFFER + BUFFER_SLACK chars long.
 */
export function appendRecentTail(tail: string, data: string): string {
  const next = tail + data;
  return next.length > MAX_BUFFER + BUFFER_SLACK ? next.slice(-MAX_BUFFER) : next;
}

/**
 * The last ≤ MAX_BUFFER chars of a rolling-tail buffer — what every reader
 * replays. Trims any hysteresis overrun left by `appendRecentTail`, so the
 * exposed tail is identical to the pre-hysteresis "always exactly capped"
 * buffer. Pure, for unit testing alongside `appendRecentTail`.
 *
 * @param tail The rolling tail (possibly overrun past MAX_BUFFER).
 * @returns The last MAX_BUFFER chars, or the whole tail when shorter.
 */
export function recentTail(tail: string): string {
  return tail.length > MAX_BUFFER ? tail.slice(-MAX_BUFFER) : tail;
}

function appendBuffer(session: Session, data: string): void {
  session.buffer = appendRecentTail(session.buffer, data);
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
    win.webContents.send(EVENT_CHANNELS.termSessions, snap);
  }
}

export function listTerminalSessions(): TermSession[] {
  return snapshot();
}

/**
 * Build the `{TABS}` provided-var payload (capability 2): the open, still-live
 * tabs as `[{sid, cwd, repo, cmd}]`. Exited sessions are excluded — a task acts
 * only on tabs that actually exist; condash keeps no per-tab state for it.
 */
export function tabsContext(): TabInfo[] {
  return [...sessions.values()]
    .filter((s) => s.exited === undefined)
    .map((s) => ({
      sid: s.id,
      cwd: s.cwd,
      ...(s.repo ? { repo: s.repo } : {}),
      ...(s.cmd ? { cmd: s.cmd } : {}),
    }));
}

/** Per-sid cumulative bytes emitted, for every live session. The scheduler
 *  diffs this against the snapshot it captured at a task's last run to find the
 *  tabs that produced new output: a sid whose count is unchanged is stale, and
 *  a task whose every tab is stale is skipped (the per-tab growth gate). Drives
 *  the `{UPDATED_TABS}` provided var. Exited sessions are excluded, matching
 *  `tabsContext()`. */
export function tabsBytes(): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions.values()) {
    if (s.exited === undefined) out.set(s.id, s.bytesSeen);
  }
  return out;
}

/** Recent plain-text output for a live session, capped to the last `maxChars`
 *  characters. Empty string when the sid is unknown or exited. Drives the
 *  dashboard summarizer (capability: live tab summaries).
 *
 *  Prefers the faithful in-band transcript when the program emits one (claude /
 *  opencode over OSC 7373): an alternate-screen TUI repaints via cursor
 *  addressing, so the rolling raw buffer is just frame noise that reads as
 *  "only a control sequence". Falls back to the cleaned raw buffer (ANSI
 *  stripped, `\r` overwrites resolved) for plain shells and non-emitters.
 *  Both sources are in-memory, so this works whether or not on-disk terminal
 *  logging is enabled. */
export function tabRecentText(sid: string, maxChars = 8000): string {
  const s = sessions.get(sid);
  if (!s || s.exited !== undefined) return '';
  // Precedence: the cooperating program's neutral sidecar file (reliable,
  // survives a hook running without condash's controlling terminal) → the
  // in-band OSC capture (same protocol, fragile transport) → the cleaned raw
  // buffer (plain shells and line-oriented commands; just repaint noise for an
  // alternate-screen TUI).
  const fileText = s.transcriptFile ? readFileTranscript(s.transcriptFile) : '';
  const text = fileText.trim()
    ? fileText
    : s.transcript.hasTranscript()
      ? s.transcript.render()
      : cleanTerminalText(recentTail(s.buffer));
  return text.length > maxChars ? text.slice(-maxChars) : text;
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
    return { output: recentTail(s.buffer), exited: s.exited };
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
  return { output: recentTail(s.buffer), exited: s.exited };
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

/** Resolve the shell to spawn: the configured value when non-blank, else the
 *  platform default. SHELL is reliably set on POSIX; on Windows it is usually
 *  unset, so fall through to ComSpec, then cmd.exe. Exported so the headless
 *  task scheduler resolves the same shell as interactive spawns. */
export function defaultShell(configured?: string): string {
  if (configured && configured.trim()) return configured;
  if (process.platform !== 'win32' && process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return '/bin/bash';
}

/** Build the argv for running `command` through `shell`. Family detection +
 *  per-family argv shape (POSIX `-c` / cmd.exe `/d /s /c` / PowerShell
 *  `-NoLogo -NonInteractive -Command`) live in the shared
 *  `src/shared/shell-quote.ts` so the task scheduler and the renderer's prompt
 *  quoting agree with the spawn path. Detection is by shell-binary basename,
 *  so a user-configured `pwsh.exe` or `git-bash.exe` is routed correctly; the
 *  POSIX branch deliberately stays a non-login shell (rationale in the shared
 *  module — the login-shell PATH is injected via spawnEnv() instead). Exported
 *  for unit testing of the cross-OS family routing. */
export function wrapForShell(shell: string, command: string): string[] {
  return shellCommandArgv(shellFamily(shell, process.platform === 'win32'), command);
}

export async function spawnTerminal(
  conceptionPath: string | null,
  webContents: WebContents,
  request: TermSpawnRequest,
): Promise<{ id: string; cwd: string }> {
  const config = conceptionPath
    ? ((await getEffectiveConceptionConfig(conceptionPath)) as ConfigShape)
    : {};
  const settings = await readSettings();
  const shell = defaultShell(settings.terminal?.shell);

  let cwd = request.cwd ?? homedir();
  let argv: string[] = [];
  let program = shell;
  let forceStop: string | undefined;
  let commandLabel: string | undefined;

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
      commandLabel = entry.run;
    }
    forceStop = entry.forceStop;
  } else if (request.command) {
    program = shell;
    argv = wrapForShell(shell, request.command);
    commandLabel = request.command;
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

  // Base env from spawnEnv(): a copy of process.env with PATH replaced by the
  // resolved login-shell PATH, so user-installed CLIs (opencode, ~/bin
  // wrappers) resolve even though GUI-launched condash never sourced
  // ~/.profile.
  //
  // Then strip the npm-cli leakage: Electron runs through whatever shell
  // launched it, which on systems with a global npm install at /usr/local
  // sets `npm_config_prefix=/usr/local`. nvm refuses to load when that is set
  // ("nvm is not compatible with the npm_config_prefix environment
  // variable"), so user shells spawned here would dump that error on boot.
  const childEnv: NodeJS.ProcessEnv = { ...(await spawnEnv()), TERM: 'xterm-256color' };
  delete childEnv.npm_config_prefix;
  delete childEnv.npm_config_globalconfig;
  delete childEnv.npm_config_userconfig;

  // Generated before the spawn so the per-tab sidecar path can be handed to the
  // child via the environment. A cooperating program (the agedum claude hook /
  // opencode plugin) appends neutral transcript frames to this file; condash
  // reads them back for the dashboard summary. Keyed by `id`, so two tabs in the
  // same cwd never share a file. Only set with an active conception (a writable
  // place under `.condash/`); mkdir failures fall back to no sidecar rather than
  // pointing the child at a directory that doesn't exist.
  const id = makeId();
  let transcriptFile: string | undefined;
  if (conceptionPath) {
    const candidate = sidecarTranscriptPath(conceptionPath, id);
    try {
      mkdirSync(dirname(candidate), { recursive: true });
      childEnv.CONDASH_TRANSCRIPT_FILE = candidate;
      transcriptFile = candidate;
    } catch {
      /* no sidecar this run — summarizer falls back to OSC / buffer */
    }
  }

  const ptyProcess = pty.spawn(program, argv, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: childEnv,
  });

  const logger = conceptionPath
    ? new SessionLogger(
        conceptionPath,
        {
          sid: id,
          side: request.side,
          repo: request.repo,
          cwd,
          spawn: { cmd: program, argv },
          taskContext: request.taskContext,
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
    cmd: commandLabel,
    bytesSeen: 0,
    cwd,
    forceStop,
    buffer: '',
    logger,
    transcript: new OscTranscriptExtractor(),
    transcriptFile,
  };
  sessions.set(id, session);
  logger?.spawn();

  // Read `session.webContents` (not the spawn-time parameter) inside the
  // handlers: attachTerminal reassigns it when a reloaded renderer
  // re-attaches, and a closure over the original WebContents would keep
  // sending live data to the destroyed one.
  ptyProcess.onData((data) => {
    session.bytesSeen += data.length;
    appendBuffer(session, data);
    // Capture any in-band transcript regardless of disk logging — the dashboard
    // reads it for a faithful summary. The stripped return is ignored here; the
    // raw `data` still drives the grid buffer and the renderer.
    session.transcript.feed(data);
    session.logger?.output(data);
    if (session.webContents.isDestroyed()) return;
    session.webContents.send(EVENT_CHANNELS.termData, { id, data });
  });
  ptyProcess.onExit(({ exitCode }) => {
    session.exited = exitCode;
    session.pty = null;
    session.logger?.exit(exitCode);
    if (!session.webContents.isDestroyed()) {
      session.webContents.send(EVENT_CHANNELS.termExit, { id, code: exitCode });
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

async function runForceStop(command: string): Promise<void> {
  // Tokenise + shell:false to mirror launchers.runForceStopRepo. Routing
  // the user-configured force_stop: string through the shell costs us
  // shell-metacharacter surprises (stray `&`, unintended globs) and ${VAR}
  // interpolation against the main-process env — the argv shape avoids
  // both. Pass-9 closes the parity gap with launchers.ts.
  const env = await spawnEnv();
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
      env,
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
    // Flush + close the log file. close() is idempotent, so a logger that
    // killAll already closed in its own sweep doesn't double-close here.
    if (session.logger) {
      void session.logger.close();
    }
    // Drop the per-tab sidecar transcript — it's only useful while the tab is
    // live. Best-effort; a leftover is harmless (gitignored) if this fails.
    if (session.transcriptFile) {
      try {
        rmSync(session.transcriptFile, { force: true });
      } catch {
        /* leftover sidecar is harmless */
      }
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

/** Await `work`, but give up after `ms` so the quit path stays bounded. */
async function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    safetyTimer = setTimeout(resolve, ms);
  });
  await Promise.race([work, timeout]).finally(() => clearTimeout(safetyTimer));
}

/** Kill every session (or every session attached to `forWebContents`) via the
 * full Stop pipeline — process-group SIGTERM, force_stop if configured,
 * SIGKILL fallback — then close every session's logger. The returned promise
 * resolves once the loggers have flushed and closed, so a quit handler that
 * awaits killAll gets the final debounce window's output (and the exit
 * footer, when onExit landed during the stop pipeline) on disk. Each phase is
 * time-bounded so the window can still close if a force_stop or a filesystem
 * write hangs. */
export async function killAll(forWebContents?: WebContents): Promise<void> {
  const targets = [...sessions.entries()].filter(
    ([, s]) => !forWebContents || s.webContents === forWebContents,
  );
  if (targets.length === 0) return;

  const stops = targets.map(([id]) => stopSession(id, { removeEntry: false }));
  await bounded(Promise.allSettled(stops), 1000);

  // stopSession({ removeEntry: false }) deliberately skips the logger, so the
  // sweep here is the only close on this path. close() is idempotent — a
  // session that separately goes through closeSession doesn't double-close.
  const closes = targets.map(([, s]) => s.logger?.close() ?? Promise.resolve());
  await bounded(Promise.allSettled(closes), 1500);

  for (const [id] of targets) sessions.delete(id);
  broadcastSessions();
}
