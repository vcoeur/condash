import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Names of the doc files exposed to the renderer through `helpReadDoc`.
 * The whitelist is the only path-traversal defence — the renderer can pass
 * any string, but only these resolve to a file.
 */
export type HelpDocName = 'architecture' | 'configuration' | 'non-goals' | 'index';

/**
 * Maps the renderer-facing slug to the actual file inside `docs/`. The slugs
 * stay short and stable for IPC; the paths point at the canonical Diátaxis
 * pages (`explanation/internals.md`, `reference/config.md`,
 * `explanation/non-goals.md`) so the in-app Help modal and the public docs
 * site read from the same source.
 */
const PATHS: Record<HelpDocName, string> = {
  index: 'index.md',
  architecture: 'explanation/internals.md',
  configuration: 'reference/config.md',
  'non-goals': 'explanation/non-goals.md',
};

/**
 * Resolve the docs/ directory. In a packaged build it sits inside the asar at
 * `<resourcesPath>/app.asar/docs/`; in dev it's the repo's `docs/` folder
 * (relative to the `dist-electron/main/index.js` entrypoint that `app.getAppPath()`
 * points at). Both paths are reached by joining `app.getAppPath()` with `docs/`.
 */
function docsDir(): string {
  return join(app.getAppPath(), 'docs');
}

export async function readHelpDoc(name: string): Promise<string> {
  const path = PATHS[name as HelpDocName];
  if (!path) {
    throw new Error(`Unknown help doc: ${name}`);
  }
  return fs.readFile(join(docsDir(), path), 'utf8');
}
