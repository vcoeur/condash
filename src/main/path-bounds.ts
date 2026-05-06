import { promises as fs } from 'node:fs';
import { sep } from 'node:path';

/**
 * Throw unless `path` resolves to a location under `root`.
 *
 * Both paths are realpathed (in parallel, to narrow the TOCTOU window
 * to what the Node fs queue allows — same shape as pass-3's pdf.toFileUrl
 * fix). Symlinks are followed; the comparison is on canonical paths so
 * a symlink under conception pointing at /etc/passwd is rejected.
 *
 * Returns the realpath of the request, so callers that downstream stat
 * or open it can do so on the canonical path (avoiding a second realpath
 * round-trip and any further TOCTOU between bounds-check and use).
 *
 * Used by IPC handlers that accept arbitrary `path` from the renderer
 * — defence-in-depth: the renderer is trusted today, but a compromised
 * renderer can otherwise reach `/etc/passwd` via getProject, readNote,
 * step.add, etc. Pass-4..6 deferred; pass-7 lands.
 */
export async function requirePathUnder(path: string, root: string): Promise<string> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  let real: string;
  let rootReal: string;
  try {
    [real, rootReal] = await Promise.all([fs.realpath(path), fs.realpath(root)]);
  } catch {
    throw new Error(`path does not resolve: ${path}`);
  }
  const child = real.endsWith(sep) ? real : real + sep;
  const parent = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (!(child === parent || child.startsWith(parent))) {
    throw new Error('path is outside the conception tree');
  }
  return real;
}
