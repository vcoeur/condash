// Thin promise wrapper around the headless-terminal Web Worker. Writes are
// fire-and-forget; create/serialize/dispose round-trip so the controller can
// sequence them safely. Each round-trip carries a request id (`rid`) the worker
// echoes back, so a reply is matched to its request exactly rather than by
// session order (which breaks if two requests for one session are ever in
// flight at once).

export class TerminalWorkerManager {
  private worker: Worker | null = null;
  private nextRequestId = 0;
  private pending = new Map<
    number,
    { resolve: (value: string) => void; reject: (err: Error) => void }
  >();

  /** Spawn the worker thread on first use and cache it. Constructing the
   *  manager is free — the Worker (and its whole module graph) is created only
   *  when a tab first needs offloading to the headless side (the first demote,
   *  i.e. the first time a second tab is hidden), keeping it off the boot path
   *  (R4). A single active tab never spawns it. */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(
      /* @vite-ignore */
      new URL('./terminal-worker.ts', import.meta.url),
      { type: 'module', name: 'condash-terminal-worker' },
    );
    worker.onmessage = (
      ev: MessageEvent<{ type: string; rid?: number; data?: string; error?: string }>,
    ) => {
      const { type, rid, data, error } = ev.data;
      // Only create/serialize/dispose carry a `rid` and expect a reply; writes
      // do not. Match the reply to its request by id.
      if (rid === undefined) return;
      const p = this.pending.get(rid);
      if (!p) return;
      this.pending.delete(rid);
      if (type === 'error') {
        p.reject(new Error(error ?? 'terminal worker error'));
      } else {
        p.resolve(data ?? '');
      }
    };
    worker.onerror = (err) => {
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
    this.worker = worker;
    return worker;
  }

  private request(type: string, sid: string, payload?: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
      const rid = this.nextRequestId++;
      this.pending.set(rid, { resolve, reject });
      this.ensureWorker().postMessage({ type, sid, rid, ...payload });
    });
  }

  create(sid: string, cols: number, rows: number, scrollback: number): Promise<void> {
    return this.request('create', sid, { cols, rows, scrollback }).then(() => undefined);
  }

  write(sid: string, data: string): void {
    this.ensureWorker().postMessage({ type: 'write', sid, data });
  }

  serialize(sid: string): Promise<string> {
    return this.request('serialize', sid);
  }

  dispose(sid: string): Promise<void> {
    return this.request('dispose', sid).then(() => undefined);
  }

  /** Terminate the underlying worker thread and reject any in-flight requests.
   *  Called when the controller is torn down so the worker (and every headless
   *  Terminal it still holds) does not outlive it. */
  terminate(): void {
    for (const [id, p] of this.pending) {
      p.reject(new Error('terminal worker terminated'));
      this.pending.delete(id);
    }
    // No-op when the worker was never spawned (single-tab session that never
    // demoted, R4).
    this.worker?.terminate();
    this.worker = null;
  }
}
