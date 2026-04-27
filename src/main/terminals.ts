import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import * as pty from 'node-pty';
import type { TermSession, TermSide, TermSpawnRequest } from '../shared/types';

interface Session {
  id: string;
  side: TermSide;
  /** Live pty handle. Set to null after the process exits — the session row
   * lingers (with `exited` populated) until the renderer explicitly closes it. */
  pty: pty.IPty | null;
  webContents: WebContents;
  /** Optional repo this session was spawned for (Run button). */
  repo?: string;
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

function makeId(): string {
  return `t${Date.now().toString(36)}-${nextId++}`;
}

export interface TerminalConfig {
  shell?: string;
  launcherCommand?: string;
  screenshotDir?: string;
}

interface RawConfigShape {
  terminal?: {
    shell?: string;
    launcher_command?: string;
    screenshot_dir?: string;
  };
  workspace_path?: string;
  repositories?: { primary?: unknown[]; secondary?: unknown[] };
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

function findRepoEntry(
  config: RawConfigShape,
  name: string,
): { run?: string; cwd?: string } | null {
  const workspace = config.workspace_path;
  const all = [...(config.repositories?.primary ?? []), ...(config.repositories?.secondary ?? [])];
  return walk(all, name, workspace, undefined);
}

function walk(
  entries: unknown[],
  target: string,
  workspace: string | undefined,
  parent: string | undefined,
): { run?: string; cwd?: string } | null {
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry === target) {
        return { cwd: resolveCwd(workspace, parent, entry) };
      }
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { name?: unknown; run?: unknown; submodules?: unknown };
    if (typeof e.name === 'string') {
      const display = parent ? `${parent}/${e.name}` : e.name;
      if (display === target || e.name === target) {
        return {
          run: typeof e.run === 'string' ? e.run : undefined,
          cwd: resolveCwd(workspace, parent, e.name),
        };
      }
      if (Array.isArray(e.submodules)) {
        const nested = walk(e.submodules, target, workspace, e.name);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function resolveCwd(
  workspace: string | undefined,
  parent: string | undefined,
  name: string,
): string {
  const segments: string[] = [];
  if (workspace) segments.push(workspace);
  if (parent) segments.push(parent);
  segments.push(name);
  return segments.length === 1 ? segments[0] : join(...segments);
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

  if (request.repo && conceptionPath) {
    const entry = findRepoEntry(config, request.repo);
    if (!entry) throw new Error(`Repo '${request.repo}' not found in configuration.json`);
    if (entry.cwd) cwd = entry.cwd;
    // Wrap the configured run: command in `bash -lc` so user-supplied shells
    // like `make dev && tail -f log` keep their pipes/&&/operators.
    if (entry.run) {
      program = shell;
      argv = ['-l', '-c', entry.run];
    }
  } else if (request.command) {
    program = shell;
    argv = ['-l', '-c', request.command];
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

export function closeSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  if (session.pty) {
    try {
      session.pty.kill();
    } catch {
      /* already gone */
    }
  }
  sessions.delete(id);
  broadcastSessions();
}

export async function getTerminalPrefs(
  conceptionPath: string | null,
): Promise<RawConfigShape['terminal']> {
  if (!conceptionPath) return {};
  const config = await readRawConfig(conceptionPath);
  return config.terminal ?? {};
}

/**
 * Find the most recently modified file under `dir` (top-level only). Returns
 * null when the directory is missing or empty.
 */
export async function latestScreenshot(dir: string): Promise<string | null> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    let stat;
    try {
      stat = await fs.stat(path);
    } catch {
      continue;
    }
    if (!best || stat.mtimeMs > best.mtime) {
      best = { path, mtime: stat.mtimeMs };
    }
  }
  return best?.path ?? null;
}

export function killAll(forWebContents?: WebContents): void {
  for (const [id, session] of sessions) {
    if (forWebContents && session.webContents !== forWebContents) continue;
    if (session.pty) {
      try {
        session.pty.kill();
      } catch {
        /* ignore */
      }
    }
    sessions.delete(id);
  }
}

export function _broadcastWindowsClosed(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    void win;
  }
}
