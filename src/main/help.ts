import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Names of the doc files exposed to the renderer through `helpReadDoc`.
 * The whitelist is the only path-traversal defence — the renderer can pass
 * any string, but only these resolve to a file.
 *
 * Help docs live under `docs/help/` and are intentionally short and
 * self-contained — no relative wikilinks. Each one ends with a pointer
 * to the matching section on the public docs site.
 */
export type HelpDocName =
  | 'welcome'
  | 'quick-start'
  | 'shortcuts'
  | 'configuration'
  | 'cli'
  | 'why-markdown';

const PATHS: Record<HelpDocName, string> = {
  welcome: 'help/welcome.md',
  'quick-start': 'help/quick-start.md',
  shortcuts: 'help/shortcuts.md',
  configuration: 'help/configuration.md',
  cli: 'help/cli.md',
  'why-markdown': 'help/why-markdown.md',
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
