import { resolve as resolvePath } from 'node:path';

/**
 * Shared text-mutation toolkit for the README/note writers. The step, status,
 * and config-write modules all read a file, edit it in memory, and write it
 * back under a per-path lock; this module owns the two primitives common to
 * all of them — line-ending detection and the per-file write queue — so the
 * three concern-specific modules don't each re-implement them.
 */

/**
 * Detect the line ending used in `raw` by majority vote. Files authored on
 * Windows with `core.autocrlf=false` ship CRLF; rejoining with `\n` would
 * flip the entire file on every step toggle and the user would see a
 * whole-file diff in `git status`. Single-line files (no separator) and
 * mostly-LF files return `'\n'`; a single stray CRLF in an otherwise LF
 * file doesn't flip the verdict.
 */
export function detectEol(raw: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) !== 10) continue;
    if (i > 0 && raw.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Serialise writes per file path so concurrent toggles don't fight each other.
 * A failure in `work` doesn't poison the queue — the next caller re-runs against
 * fresh state — but each caller still sees its own error. The renderer surfaces
 * a clean message either way.
 *
 * The queue key is the resolved-absolute path: callers that pass slightly
 * different spellings of the same file (`./a/b.md`, `a/b.md`, `a/./b.md`)
 * still serialise against one queue entry instead of racing on disjoint keys.
 */
export async function withFileQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = resolvePath(path);
  const prev = queues.get(key) ?? Promise.resolve();
  // Swallow the previous run's error for queueing purposes (so a failed mutation
  // doesn't block subsequent ones), then run our own work and rethrow any error
  // the caller cares about.
  const next: Promise<T> = prev.catch(() => undefined).then(work);
  // The retained copy is pre-handled: a rejection from `work` must reach only
  // the caller — a bare stored promise would surface the same error a second
  // time as an unhandled rejection whenever no follower chains onto it. The
  // cleanup also has to compare against the *stored* promise (not `next`),
  // else entries linger in the map forever.
  const stored: Promise<unknown> = next
    .catch(() => undefined)
    .finally(() => {
      if (queues.get(key) === stored) queues.delete(key);
    });
  queues.set(key, stored);
  return next;
}
