/** Normalise a filesystem path to forward-slash form, suitable for
 *  shipping over IPC and for the renderer to split on `/`. Identity on
 *  POSIX (no `\` ever appears in paths there); converts `\` → `/` on
 *  Windows. Drive letters (`C:`) pass through unchanged.
 *
 *  Per CLAUDE.md, every path that crosses the IPC boundary is shaped
 *  this way so the renderer never has to think about per-OS separators. */
export function toPosix(path: string): string {
  return path.includes('\\') ? path.replace(/\\/g, '/') : path;
}

/** Last segment of a forward-slash path. Convenience for renderer code
 *  that previously did `p.split('/').pop()` — keeps the same behaviour
 *  but spells the intent. */
export function posixBasename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}
