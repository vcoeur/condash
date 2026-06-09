import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Dot-prefixed segments *below* the knowledge root are excluded. Tested
// against the path relative to the knowledge root — never the absolute path,
// which would zero out every knowledge file when the conception itself lives
// under a dotted ancestor directory (e.g. `~/.conceptions/x`).
const KNOWLEDGE_IGNORED = /(^|\/)\.[^/]+/;

// Heavy/non-content dirs: skip them in the markdown walker to avoid pulling
// thousands of irrelevant `.md` files (npm package READMEs, vendored docs,
// build output) when a stray `node_modules/`, `.git/`, `dist/`, or `target/`
// somehow sits under the conception tree. `notes/` is *not* skipped here —
// project notes are searchable body content. `local/` carries gitignored
// deliverables and is also excluded.
//
// Shared with the index classifier (`index-cache.ts classifyIndexedPath`) so
// walker and incremental-event membership never drift, and kept in sync with
// the watcher's ignore rules (`src/main/watcher.ts`) — a dir the watcher
// never reports events for must not be indexed, or its entries would ghost.
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'local',
  'dist',
  'target',
]);

export interface ProjectFile {
  path: string;
  /** Absolute path of the owning project directory (item dir). */
  projectPath: string;
}

/**
 * Walk every `.md` file under each `projects/<month>/<slug>/` directory and
 * tag it with its owning project. The README and any `notes/**.md` are both
 * surfaced — the matcher then groups them in the renderer.
 */
export async function collectProjectFiles(projectsRoot: string): Promise<ProjectFile[]> {
  const months = await readSubdirs(projectsRoot);
  const out: ProjectFile[] = [];
  for (const month of months) {
    const items = await readSubdirs(join(projectsRoot, month));
    for (const item of items) {
      const projectDir = join(projectsRoot, month, item);
      await walkMarkdown(projectDir, (file) => {
        out.push({ path: file, projectPath: projectDir });
      });
    }
  }
  return out;
}

/** Walk every `.md` file under `<conception>/knowledge/`. */
export async function collectKnowledgeFiles(knowledgeRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walkMarkdown(knowledgeRoot, (file) => {
    if (knowledgeIgnored(knowledgeRoot, file)) return;
    out.push(file);
  });
  return out;
}

/**
 * Walk every knowledge **body** file — `.md` excluding the auto-generated
 * `index.md` at any level. The `knowledge verify` and `stale-verification`
 * scans use this so they never flag a generated index as an unstamped body
 * file; search uses `collectKnowledgeFiles` (which keeps index content
 * searchable). Shares the same recursor / skip rules as the other walkers.
 */
export async function collectKnowledgeBodyFiles(knowledgeRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walkMarkdown(knowledgeRoot, (file) => {
    if (knowledgeIgnored(knowledgeRoot, file)) return;
    if (file.endsWith(`${sep}index.md`) || file.endsWith('/index.md')) return;
    out.push(file);
  });
  return out;
}

/** Walk every `index.md` under `<conception>/knowledge/` — the triage-bullet
 * source the `knowledge retrieve` command parses. */
export async function collectKnowledgeIndexFiles(knowledgeRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walkMarkdown(knowledgeRoot, (file) => {
    if (knowledgeIgnored(knowledgeRoot, file)) return;
    if (file.endsWith(`${sep}index.md`) || file.endsWith('/index.md')) out.push(file);
  });
  return out;
}

/**
 * Walk every `.md` and `.txt` file under the configured resources root.
 * The resources tree may contain dotfiles inside subdirectories; we still
 * skip dot-prefixed segments below the root for the same noise-reduction
 * reasons knowledge does.
 */
export async function collectResourceFiles(resourcesRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walkExtensions(resourcesRoot, RESOURCE_EXTS, (file) => out.push(file));
  return out;
}

/**
 * Walk every `.md` file under the configured skills root. The default
 * skills root sits inside `.claude/`, so the dot-prefixed-segment skip
 * applies *below* the root only — entries directly under the root are
 * always followed.
 */
export async function collectSkillFiles(skillsRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walkExtensions(skillsRoot, SKILL_EXTS, (file) => out.push(file));
  return out;
}

/**
 * Walk every saved session log under `<conception>/.condash/logs/`. The
 * tree shape is `YYYY/MM/DD/HHMMSS-<sid>.txt` — sessions are plain text
 * since v2.27.0 (no compression, no SGR).
 */
export async function collectLogFiles(logsRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walkPredicate(
    logsRoot,
    (name) => name.endsWith('.txt'),
    (file) => out.push(file),
  );
  return out;
}

// Shared with the index classifier (`index-cache.ts`) — single source of
// truth for "what counts as a resource file" on both the walk and the
// incremental-event path.
export const RESOURCE_EXTS: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt']);
const SKILL_EXTS = new Set(['.md']);

/** True when `file` carries a dot-prefixed segment below `knowledgeRoot`. */
function knowledgeIgnored(knowledgeRoot: string, file: string): boolean {
  return KNOWLEDGE_IGNORED.test(relative(knowledgeRoot, file).split(sep).join('/'));
}

async function readSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function walkMarkdown(dir: string, visit: (file: string) => void): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walkMarkdown(full, visit);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      visit(full);
    }
  }
}

/**
 * Recursive walker keyed on a name predicate. Same dot-prefix and
 * SKIP_DIR_NAMES rules as the walkers above; the root itself is always
 * descended into so log roots under `.condash/` work. */
async function walkPredicate(
  dir: string,
  match: (name: string) => boolean,
  visit: (file: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walkPredicate(full, match, visit);
    } else if (entry.isFile() && match(entry.name.toLowerCase())) {
      visit(full);
    }
  }
}

/**
 * Recursive walker that surfaces files matching any of `exts`. Always
 * follows the directory passed in (dot-prefixed roots are fine — the
 * skills tree sits under `.claude/`); below the root, dot-prefixed
 * segments are skipped, like the markdown walker.
 */
async function walkExtensions(
  dir: string,
  exts: ReadonlySet<string>,
  visit: (file: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walkExtensions(full, exts, visit);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      const dot = lower.lastIndexOf('.');
      // `slice(dot)` keeps the leading dot, so `exts` must contain `'.md'`
      // rather than `'md'`. This convention is shared with the call sites.
      if (dot >= 0 && exts.has(lower.slice(dot))) visit(full);
    }
  }
}
