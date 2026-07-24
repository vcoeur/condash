// Headless xterm.js worker: one Terminal per hidden session. This keeps ANSI
// parsing, scrollback, and cursor bookkeeping for background tabs off the
// renderer main thread (PR-F).

import './terminal-worker-polyfill';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

type WorkerMessage =
  | { type: 'create'; sid: string; rid: number; cols: number; rows: number; scrollback: number }
  | { type: 'write'; sid: string; data: string }
  | { type: 'serialize'; sid: string; rid: number }
  | { type: 'dispose'; sid: string; rid: number };

interface WorkerSession {
  term: Terminal;
  serialize: SerializeAddon;
}

const sessions = new Map<string, WorkerSession>();

/** Resolve the manager's request `rid` with a string payload. */
function reply(rid: number, data: string): void {
  self.postMessage({ type: 'ok', rid, data });
}

/** Reject the manager's request `rid` with an error message. */
function replyError(rid: number, message: string): void {
  self.postMessage({ type: 'error', rid, error: message });
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
    reply(msg.rid, '');
  } catch (err) {
    replyError(msg.rid, err instanceof Error ? err.message : String(err));
  }
}

function handleWrite(msg: Extract<WorkerMessage, { type: 'write' }>): void {
  const session = sessions.get(msg.sid);
  if (!session) return;
  try {
    session.term.write(msg.data);
  } catch {
    /* xterm parser errors are non-fatal */
  }
}

function handleSerialize(msg: Extract<WorkerMessage, { type: 'serialize' }>): void {
  const session = sessions.get(msg.sid);
  if (!session) {
    reply(msg.rid, '');
    return;
  }
  try {
    reply(msg.rid, session.serialize.serialize());
  } catch (err) {
    replyError(msg.rid, err instanceof Error ? err.message : String(err));
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
  reply(msg.rid, '');
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
