// Spawn-deadline enforcement from a worker thread.
//
// `execFile`'s `timeout` is a main-process JS timer: when the event loop is
// blocked, the kill fires late — a 15 s cap stretches to 24 s+ under load
// (the PR-lookup p50 in the 2026-09 perf corpus). A worker thread runs its
// own event loop, independent of the main thread's, so a deadline armed here
// kills the child on schedule even while the main loop is saturated.
//
// The worker is created per deadline and unref'd; its timer is ref'd inside
// the worker so the worker lives until the deadline fires, and
// `worker.unref()` keeps it from holding the app open. Disarming (the child
// settled in time) terminates the worker — best-effort protection against pid
// recycling: disarm runs on the main loop, so under a blocked loop the
// deadline can still fire after the child exited and its pid was recycled,
// delivering SIGTERM to an innocent process. That is the same exposure as
// Node's own timeout kill; the deadline buys a bounded cap despite a blocked
// loop, not a recycling guarantee.
import { Worker } from 'node:worker_threads';

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (job) => {
  const timer = setTimeout(() => {
    try {
      process.kill(job.pid, job.signal);
    } catch {
      // ESRCH — the child already exited; nothing to kill.
    }
    parentPort.postMessage(null);
  }, job.delayMs);
  timer.ref();
});
`;

/**
 * Kill `pid` with `signal` after `delayMs`, regardless of the main thread's
 * event-loop health. Returns a disarm function — call it when the child
 * settles to cancel the pending kill; it can only take effect once the main
 * loop runs it, so a blocked loop leaves the same small pid-recycling window
 * as Node's own timeout kill (see the module header). Idempotent; a dead
 * deadline worker (spawn failure) silently leaves the child alone, which is
 * what the internal `execFile` timeout backstop exists for.
 *
 * @param pid     The child process pid to signal at the deadline.
 * @param delayMs Milliseconds before the signal is delivered.
 * @param signal  Defaults to SIGTERM (matches execFile's killSignal default).
 * @returns Disarm function; calling it cancels the pending kill.
 */
export function armSpawnDeadline(
  pid: number,
  delayMs: number,
  signal: NodeJS.Signals = 'SIGTERM',
): () => void {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  worker.unref();
  let pending = true;
  worker.once('message', () => {
    pending = false;
    void worker.terminate();
  });
  worker.on('error', () => {
    pending = false;
  });
  worker.postMessage({ pid, delayMs, signal });
  return () => {
    if (!pending) return;
    pending = false;
    void worker.terminate();
  };
}
