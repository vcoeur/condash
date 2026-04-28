import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import * as pty from 'node-pty';
import type { TermSession, TermSide, TermSpawnRequest } from '../shared/types';
import { findRepoEntry, type ConfigShape } from './config-walk';

interface Session {
  id: string;
  side: TermSide;
  /** Live pty handle. Set to null after the process exits — the session row
   * lingers (with `exited` populated) until the renderer explicitly closes it. */
  pty: pty.IPty | null;
  webContents: WebContents;
  /** Optional repo this session was spawned for (Run button). */
  repo?: string;
  /** Captured at spawn time so Stop doesn't need conceptionPath at kill time. */
  forceStop?: string;
  /** Rolling tail of stdout/stderr — replayed when a freshly-loaded renderer
   * re-attaches via term.attach. Capped at MAX_BUFFER bytes. */
  buffer: string;
  /** Process exit code; undefined while live. */
  exited?: number;
}

const MAX_BUFFER = 64_000;
const sessions = new Map<string, Session>();
let nextId = 1;

function appendBuffer(session: Session, data: string): void {
  session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
}

function snapshot(): TermSession[] {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    side: s.side,
    repo: s.repo,
    exited: s.exited,
  }));
}

function broadcastSessions(): void {
  const snap = snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('term.sessions', snap);
    }
  }
}

export function listTerminalSessions(): TermSession[] {
  return snapshot();
}

export function attachTerminal(id: string): { output: string; exited?: number } | null {
  const s = sessions.get(id);
  if (!s) return null;
  return { output: s.buffer, exited: s.exited };
}

/** Move a session between the "my" and "code" sides. Used by the Code tab's
 * pop-out button to surface a running dev server in the bottom pane. */
export function setSessionSide(id: string, side: TermSide): void {
  const s = sessions.get(id);
  if (!s || s.side === side) return;
  s.side = side;
  broadcastSessions();
}

function makeId(): string {
  return `t${Date.now().toString(36)}-${nextId++}`;
}

interface RawConfigShape extends ConfigShape {
  terminal?: {
    shell?: string;
    launcher_command?: string;
    screenshot_dir?: string;
  };
}

async function readRawConfig(conceptionPath: string): Promise<RawConfigShape> {
  try {
    const raw = await fs.readFile(join(conceptionPath, 'configuration.json'), 'utf8');
    return JSON.parse(raw) as RawConfigShape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function defaultShell(configured?: string): string {
  if (configured && configured.trim()) return configured;
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'win32') return 'cmd.exe';
  return '/bin/bash';
}

export async function spawnTerminal(
  conceptionPath: string | null,
  webContents: WebContents,
  request: TermSpawnRequest,
): Promise<{ id: string; cwd: string }> {
  const config = conceptionPath ? await readRawConfig(conceptionPath) : {};
  const shell = defaultShell(config.terminal?.shell);

  let cwd = request.cwd ?? process.env.HOME ?? '/';
  let argv: string[] = [];
  let program = shell;
  let forceStop: string | undefined;

  if (request.repo && conceptionPath) {
    const entry = findRepoEntry(config, request.repo);
    if (!entry) throw new Error(`Repo '${request.repo}' not found in configuration.json`);
    // Honour an explicit request.cwd (worktree path from the Code-tab Run
    // button on a non-primary branch) over the entry's resolved primary
    // checkout. Without this, every Run lands on the primary checkout
    // regardless of which branch row the user clicked.
    if (!request.cwd && entry.cwd) cwd = entry.cwd;
    // Wrap the configured run: command in `bash -lc` so user-supplied shells
    // like `make dev && tail -f log` keep their pipes/&&/operators.
    if (entry.run) {
      program = shell;
      argv = ['-l', '-c', entry.run];
    }
    forceStop = entry.forceStop;
  } else if (request.command) {
    program = shell;
    argv = ['-l', '-c', request.command];
  }

  // One run per repo: kill any prior code-side session for the same repo
  // before we spawn. Awaited so renderer reactions stay clean
  // (term.sessions snapshot drops the old entry first, then we add the new
  // one), and so the dev port is freed before the new run binds.
  if (request.side === 'code' && request.repo) {
    const stale = [...sessions.values()].filter(
      (s) => s.side === 'code' && s.repo === request.repo,
    );
    await Promise.all(stale.map((s) => stopSession(s.id)));
  }

  const cols = request.cols ?? 80;
  const rows = request.rows ?? 24;

  const ptyProcess = pty.spawn(program, argv, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const id = makeId();
  const session: Session = {
    id,
    side: request.side,
    pty: ptyProcess,
    webContents,
    repo: request.repo,
    forceStop,
    buffer: '',
  };
  sessions.set(id, session);

  ptyProcess.onData((data) => {
    appendBuffer(session, data);
    if (webContents.isDestroyed()) return;
    webContents.send('term.data', { id, data });
  });
  ptyProcess.onExit(({ exitCode }) => {
    session.exited = exitCode;
    session.pty = null;
    if (!webContents.isDestroyed()) {
      webContents.send('term.exit', { id, code: exitCode });
    }
    // Keep the entry around (with `exited` set) so renderers that reload
    // can still see it via termList — closeSession removes it on demand.
    broadcastSessions();
  });

  webContents.once('destroyed', () => {
    closeSession(id);
  });

  broadcastSessions();
  return { id, cwd };
}

export function writeTerminal(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session?.pty) return;
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

function runForceStop(command: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn(command, {
      detached: true,
      stdio: 'ignore',
      shell: true,
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
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
    if (isAlive(p)) killTree(p, 'SIGKILL');
  }

  if (removeEntry) {
    sessions.delete(id);
    broadcastSessions();
  }
}

export function closeSession(id: string): Promise<void> {
  return stopSession(id);
}

export async function getTerminalPrefs(
  conceptionPath: string | null,
): Promise<RawConfigShape['terminal']> {
  if (!conceptionPath) return {};
  const config = await readRawConfig(conceptionPath);
  return config.terminal ?? {};
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
