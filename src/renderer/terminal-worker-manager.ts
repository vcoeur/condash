// Thin promise wrapper around the headless-terminal Web Worker. One request at
// a time per session id is enough for our needs: writes/resizes are
// fire-and-forget, while create/serialize/dispose round-trip so the controller
// can sequence them safely.

export class TerminalWorkerManager {
  private worker: Worker;
  private nextRequestId = 0;
  private pending = new Map<
    number,
    { sid: string; resolve: (value: string) => void; reject: (err: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(
      /* @vite-ignore */
      new URL('./terminal-worker.ts', import.meta.url),
      { type: 'module', name: 'condash-terminal-worker' },
    );
    this.worker.onmessage = (
      ev: MessageEvent<{ type: string; sid: string; data?: string; error?: string }>,
    ) => {
      const { type, sid, data, error } = ev.data;
      // Resolve the oldest pending request for this session. Writes/resizes do
      // not expect replies, so only create/serialize/dispose end up here.
      let matched: number | null = null;
      for (const [id, p] of this.pending) {
        if (p.sid === sid) {
          matched = id;
          break;
        }
      }
      if (matched === null) return;
      const p = this.pending.get(matched)!;
      this.pending.delete(matched);
      if (type === 'error') {
        p.reject(new Error(error ?? 'terminal worker error'));
      } else {
        p.resolve(data ?? '');
      }
    };
    this.worker.onerror = (err) => {
      // eslint-disable-next-line no-console
      console.error(
        '[terminal-worker] load/runtime error',
        err.message,
        err.filename,
        err.lineno,
        err.colno,
      );
      // Fail any in-flight requests so the controller doesn't hang waiting for a
      // worker that will never reply.
      for (const [id, p] of this.pending) {
        p.reject(new Error(`terminal worker failed: ${err.message}`));
        this.pending.delete(id);
      }
    };
  }

  private request(type: string, sid: string, payload?: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pending.set(id, { sid, resolve, reject });
      this.worker.postMessage({ type, sid, ...payload });
    });
  }

  create(sid: string, cols: number, rows: number, scrollback: number): Promise<void> {
    return this.request('create', sid, { cols, rows, scrollback }).then(() => undefined);
  }

  write(sid: string, data: string): void {
    this.worker.postMessage({ type: 'write', sid, data });
  }

  resize(sid: string, cols: number, rows: number): void {
    this.worker.postMessage({ type: 'resize', sid, cols, rows });
  }

  serialize(sid: string): Promise<string> {
    return this.request('serialize', sid);
  }

  dispose(sid: string): Promise<void> {
    return this.request('dispose', sid).then(() => undefined);
  }
}
