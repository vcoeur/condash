import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Names of the doc files exposed to the renderer through `helpReadDoc`.
 * The whitelist is the only path-traversal defence — the renderer can pass
 * any string, but only these resolve to a file.
 */
export type HelpDocName =
  | 'welcome'
  | 'getting-started'
  | 'install'
  | 'first-launch'
  | 'shortcuts'
  | 'configuration'
  | 'cli'
  | 'mutations'
  | 'architecture'
  | 'why-markdown'
  | 'values'
  | 'non-goals'
  | 'index';

/**
 * Maps the renderer-facing slug to the actual file inside `docs/`. Keeping the
 * slugs short and stable lets the IPC contract stay tiny while the canonical
 * Diátaxis paths can move freely. The Help modal and the public docs site
 * read the same files — the asar bundles the entire `docs/` tree.
 */
const PATHS: Record<HelpDocName, string> = {
  welcome: 'index.md',
  index: 'index.md',
  'getting-started': 'get-started/index.md',
  install: 'get-started/install.md',
  'first-launch': 'get-started/first-launch.md',
  shortcuts: 'reference/shortcuts.md',
  configuration: 'reference/config.md',
  cli: 'reference/cli.md',
  mutations: 'reference/mutations.md',
  architecture: 'explanation/internals.md',
  'why-markdown': 'explanation/why-markdown.md',
  values: 'explanation/values.md',
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
