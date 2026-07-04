// Headless xterm.js worker: one Terminal per hidden session. This keeps ANSI
// parsing, scrollback, and cursor bookkeeping for background tabs off the
// renderer main thread (PR-F).

import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

type WorkerMessage =
  | { type: 'create'; sid: string; cols: number; rows: number; scrollback: number }
  | { type: 'write'; sid: string; data: string }
  | { type: 'resize'; sid: string; cols: number; rows: number }
  | { type: 'serialize'; sid: string }
  | { type: 'dispose'; sid: string };

interface WorkerSession {
  term: Terminal;
  serialize: SerializeAddon;
}

const sessions = new Map<string, WorkerSession>();

function post(type: 'created' | 'serialized' | 'disposed' | 'error', sid: string, data?: string) {
  self.postMessage({ type, sid, data });
}

function getSession(sid: string): WorkerSession | undefined {
  return sessions.get(sid);
}

function handleCreate(msg: Extract<WorkerMessage, { type: 'create' }>): void {
  try {
    disposeSession(msg.sid);
    const term = new Terminal({
      cols: msg.cols,
      rows: msg.rows,
      scrollback: msg.scrollback,
      allowProposedApi: true,
    });
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    sessions.set(msg.sid, { term, serialize });
    post('created', msg.sid);
  } catch (err) {
    post('error', msg.sid, err instanceof Error ? err.message : String(err));
  }
}

function handleWrite(msg: Extract<WorkerMessage, { type: 'write' }>): void {
  const session = getSession(msg.sid);
  if (!session) return;
  try {
    session.term.write(msg.data);
  } catch {
    /* xterm parser errors are non-fatal */
  }
}

function handleResize(msg: Extract<WorkerMessage, { type: 'resize' }>): void {
  const session = getSession(msg.sid);
  if (!session) return;
  try {
    session.term.resize(msg.cols, msg.rows);
  } catch {
    /* resize on a dead session is non-fatal */
  }
}

function handleSerialize(msg: Extract<WorkerMessage, { type: 'serialize' }>): void {
  const session = getSession(msg.sid);
  if (!session) {
    post('serialized', msg.sid, '');
    return;
  }
  try {
    post('serialized', msg.sid, session.serialize.serialize());
  } catch (err) {
    post('error', msg.sid, err instanceof Error ? err.message : String(err));
  }
}

function disposeSession(sid: string): void {
  const session = sessions.get(sid);
  if (!session) return;
  sessions.delete(sid);
  try {
    session.serialize.dispose();
    session.term.dispose();
  } catch {
    /* disposal failures are non-fatal */
  }
}

function handleDispose(msg: Extract<WorkerMessage, { type: 'dispose' }>): void {
  disposeSession(msg.sid);
  post('disposed', msg.sid);
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'create':
      handleCreate(msg);
      break;
    case 'write':
      handleWrite(msg);
      break;
    case 'resize':
      handleResize(msg);
      break;
    case 'serialize':
      handleSerialize(msg);
      break;
    case 'dispose':
      handleDispose(msg);
      break;
    default:
      /* unknown message — ignore */
      break;
  }
};
