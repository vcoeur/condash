import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Names of the doc files exposed to the renderer through `helpReadDoc`.
 * The whitelist is the only path-traversal defence — the renderer can pass
 * any string, but only these resolve to a file.
 */
export type HelpDocName = 'architecture' | 'configuration' | 'non-goals' | 'index';

const ALLOWED: ReadonlySet<HelpDocName> = new Set<HelpDocName>([
  'architecture',
  'configuration',
  'non-goals',
  'index',
]);

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
  if (!ALLOWED.has(name as HelpDocName)) {
    throw new Error(`Unknown help doc: ${name}`);
  }
  return fs.readFile(join(docsDir(), `${name}.md`), 'utf8');
}
