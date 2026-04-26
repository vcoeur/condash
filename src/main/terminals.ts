import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import * as pty from 'node-pty';
import type { TermSide, TermSpawnRequest } from '../shared/types';

interface Session {
  id: string;
  side: TermSide;
  pty: pty.IPty;
  webContents: WebContents;
}

const sessions = new Map<string, Session>();
let nextId = 1;

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
  const session: Session = { id, side: request.side, pty: ptyProcess, webContents };
  sessions.set(id, session);

  ptyProcess.onData((data) => {
    if (webContents.isDestroyed()) return;
    webContents.send('term.data', { id, data });
  });
  ptyProcess.onExit(({ exitCode }) => {
    if (!webContents.isDestroyed()) {
      webContents.send('term.exit', { id, code: exitCode });
    }
    sessions.delete(id);
  });

  webContents.once('destroyed', () => {
    closeSession(id);
  });

  return { id, cwd };
}

export function writeTerminal(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.pty.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.pty.resize(Math.max(1, cols), Math.max(1, rows));
  } catch {
    /* the pty may have just exited */
  }
}

export function closeSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.pty.kill();
  } catch {
    /* already gone */
  }
  sessions.delete(id);
}

export function killAll(forWebContents?: WebContents): void {
  for (const [id, session] of sessions) {
    if (forWebContents && session.webContents !== forWebContents) continue;
    try {
      session.pty.kill();
    } catch {
      /* ignore */
    }
    sessions.delete(id);
  }
}

export function _broadcastWindowsClosed(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    void win;
  }
}
