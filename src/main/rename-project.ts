import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { atomicWrite } from './atomic-write';
import { touchDirtyMarker } from './dirty';
import { pathExists } from './fs-helpers';
import { regenerateIndex, type IndexRegenReport } from './index-tree';
import { projectsStrategy } from './index-projects';
import { withFileQueue } from './mutate-shared';
import { SKIP_DIR_NAMES } from './search/walk';
import { toPosix } from '../shared/path';
import { isValidSlugTail } from '../shared/slug';
import { CliError, ExitCodes } from '../cli/output';

/**
 * Rename an item: move `projects/<month>/<YYYY-MM-DD>-<old>/` to
 * `projects/<month>/<YYYY-MM-DD>-<new>/` and rewrite every inbound reference
 * across the tree. The date prefix and the month directory never change —
 * moving an item to another month is a different operation with its own
 * index effects (condash#582's out-of-scope list).
 *
 * The split follows `rewrite-headers.ts`: {@link planReferenceRewrites} is
 * pure (unit-testable over file contents), and {@link renameProjectCore} is
 * the disk driver — resolve is done by the CLI verb (the repo pattern: the
 * verb resolves, `createProjectCore` validates + writes), which hands over
 * the canonical dated folder name.
 *
 * Full dated folder name (`YYYY-MM-DD-<kebab>`) is the match key everywhere,
 * on a slug boundary — renaming `…-foo` never touches `…-foo-bar`. Short-form
 * wikilinks (`[[foo]]`) are deliberately NOT rewritten: they match on
 * substrings of the tail, so a mechanical rewrite would silently retarget
 * unrelated items; the help text says so.
 */

/** Repos-relative POSIX path of one scanned reference site. */
export interface RenameEdit {
  /** Repo-relative, POSIX-separated path of the file AFTER the rename — for
   *  the moved item's own files that is the new folder, in dry-run too, so
   *  both modes print the durable location. */
  file: string;
  /** 1-based line number in the original content. */
  line: number;
  /** The old full dated slug. */
  old: string;
  /** The new full dated slug. */
  new: string;
}

export interface RenameProjectReport {
  /** Repo-relative POSIX paths of the moved item directory. */
  moved: { from: string; to: string };
  edits: RenameEdit[];
  dryRun: boolean;
  /** Compact index-regeneration summary; absent under --dry-run. */
  indexes?: { tree: 'projects'; created: number; updated: number; unchanged: number };
}

export interface FileRewritePlan {
  /** Repo-relative POSIX path as scanned (the old location). */
  file: string;
  /** Full new content — a byte-local replace, so line endings survive as-is. */
  content: string;
  edits: { line: number; old: string; new: string }[];
}

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;

/** Files the reference sweep reads. Generated `index.md` files are excluded
 *  at any level — they are regenerated, not rewritten. */
const SCAN_ROOTS = ['projects', 'knowledge', 'docs'] as const;
const SCAN_EXTS = new Set(['.md', '.mdx']);

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Non-slug character or end-of-line — the value boundary for path text and
 *  parent fields. Slugs are `[a-z0-9-]`, so anything else ends a match and
 *  `…-foo-bar` never matches a `…-foo` rename. */
const SLUG_BOUNDARY = '(?=[^a-z0-9-]|$)';

/**
 * Plan the rewrites for one file's content. Returns `null` when nothing
 * matches. Pure: no fs, no clock.
 *
 * Three matchers, one match key (the full dated slug):
 *  1. Wikilink `[[OLD]]` / `[[OLD|label]]` / `[[OLD#anchor]]` / `[[OLD/…]]` —
 *     terminator ∈ `]`, `|`, `#`, `/`.
 *  2. Parent field — YAML `parent: OLD` and legacy bold-prose `**Parent**: OLD`
 *     (bare, quoted, or backticked), as `shared/header.ts:177-181` parses it.
 *  3. Path text — `projects/<YYYY-MM>/OLD` followed by a non-slug char, which
 *     covers relative Markdown links, backticked citations, and `**Verified:**`
 *     stamps in one pattern.
 */
export function planFileRewrites(
  file: string,
  content: string,
  oldSlug: string,
  newSlug: string,
): FileRewritePlan | null {
  const esc = escapeRe(oldSlug);
  const matchers: { re: RegExp; replace: string }[] = [
    // Wikilink: the terminator lookahead keeps `[[OLD-bar]]` untouched.
    { re: new RegExp(`\\[\\[${esc}(?=[\\]|#/])`, 'g'), replace: `[[${newSlug}` },
    // Parent field: YAML `parent:` and bold-prose `**Parent**:`, value bare,
    // quoted, or backticked (case-insensitive — the legacy bold-prose parser
    // reads keys in any case). The match consumes prefix + OLD and the
    // replacement re-emits prefix + NEW, so the boundary lookahead only
    // guards; trailing prose after a backticked value survives.
    {
      re: new RegExp(
        `^([ \\t]*(?:parent|\\*\\*[Pp]arent\\*\\*)[ \\t]*:[ \\t]*(?:["'\`]?))${esc}${SLUG_BOUNDARY}`,
        'gmi',
      ),
      replace: `$1${newSlug}`,
    },
    // Path text: relative links, backticked citations, Verified stamps.
    {
      re: new RegExp(`(projects/\\d{4}-\\d{2}/)(${esc})${SLUG_BOUNDARY}`, 'g'),
      replace: `$1${newSlug}`,
    },
  ];

  const edits: { line: number; old: string; new: string }[] = [];
  let updated = content;
  for (const { re, replace } of matchers) {
    for (const match of updated.matchAll(re)) {
      edits.push({
        line: lineOf(updated, match.index ?? 0),
        old: oldSlug,
        new: newSlug,
      });
    }
    updated = updated.replace(re, replace);
  }
  if (edits.length === 0) return null;
  edits.sort((a, b) => a.line - b.line);
  return { file, content: updated, edits };
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Plan rewrites across a whole file set. Only files with at least one edit
 * come back, in input order.
 */
export function planReferenceRewrites(
  files: readonly { file: string; content: string }[],
  oldSlug: string,
  newSlug: string,
): FileRewritePlan[] {
  const plans: FileRewritePlan[] = [];
  for (const { file, content } of files) {
    const plan = planFileRewrites(file, content, oldSlug, newSlug);
    if (plan) plans.push(plan);
  }
  return plans;
}

/** Recurse `dir`, visiting every scannable Markdown file. Same skip rules as
 *  the search walker (`SKIP_DIR_NAMES` + dot-dirs); `index.md` is excluded so
 *  generated files are never hand-edited — the regen step owns them. */
async function collectReferenceFiles(dir: string, visit: (file: string) => void): Promise<void> {
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
      await collectReferenceFiles(full, visit);
    } else if (entry.isFile() && entry.name !== 'index.md') {
      const dot = entry.name.toLowerCase().lastIndexOf('.');
      if (dot >= 0 && SCAN_EXTS.has(entry.name.toLowerCase().slice(dot))) visit(full);
    }
  }
}

/**
 * Validate + plan + apply an item rename. `oldFolder` is the canonical dated
 * folder name a `resolveSlug` call produced; `newSlug` is the bare kebab tail
 * (`create`'s slug rule). See the module header for the design.
 */
export async function renameProjectCore(
  conceptionPath: string,
  oldFolder: string,
  newSlug: string,
  options: { dryRun?: boolean } = {},
): Promise<RenameProjectReport> {
  const dryRun = options.dryRun === true;
  if (!DATE_PREFIX_RE.test(oldFolder)) {
    throw new CliError(
      ExitCodes.VALIDATION,
      `Item folder '${oldFolder}' has no YYYY-MM-DD- date prefix — rename only covers dated items`,
    );
  }
  if (!isValidSlugTail(newSlug)) {
    throw new CliError(
      ExitCodes.VALIDATION,
      `New slug must be lowercase letters/digits separated by single hyphens; got '${newSlug}'`,
    );
  }
  const oldTail = oldFolder.replace(DATE_PREFIX_RE, '');
  if (newSlug === oldFolder || newSlug === oldTail) {
    throw new CliError(ExitCodes.VALIDATION, 'Old and new slugs are identical');
  }

  const month = oldFolder.slice(0, 7);
  const newFolder = `${oldFolder.slice(0, 10)}-${newSlug}`;
  const oldRel = `projects/${month}/${oldFolder}`;
  const newRel = `projects/${month}/${newFolder}`;
  const oldDir = join(conceptionPath, oldRel);
  const newDir = join(conceptionPath, newRel);
  if (await pathExists(newDir)) {
    throw new CliError(ExitCodes.VALIDATION, `Item already exists at ${newRel}`);
  }

  // Plan from on-disk content before the move — content is what matters, and
  // each plan keeps the file's scanned path so the apply step can remap the
  // moved item's own files to their new folder.
  const scanRoots = SCAN_ROOTS.map((root) => join(conceptionPath, root));
  const files: { file: string; content: string }[] = [];
  for (const root of scanRoots) {
    await collectReferenceFiles(root, (abs) => {
      files.push({ file: abs, content: '' });
    });
  }
  for (const entry of files) {
    entry.content = await fs.readFile(entry.file, 'utf8');
  }
  const plans = planReferenceRewrites(
    files.map(({ file: abs, content }) => ({
      file: toPosix(relative(conceptionPath, abs)),
      content,
    })),
    oldFolder,
    newFolder,
  );

  // Report paths are the post-rename locations, so dry-run and apply print
  // the same durable path for every edit.
  const movedPrefix = `${oldRel}/`;
  const newPrefix = `${newRel}/`;
  const reportPath = (file: string) =>
    file.startsWith(movedPrefix) ? `${newPrefix}${file.slice(movedPrefix.length)}` : file;
  const edits: RenameEdit[] = plans.flatMap((plan) =>
    plan.edits.map((edit) => ({ ...edit, file: reportPath(plan.file) })),
  );

  const report: RenameProjectReport = {
    moved: { from: oldRel, to: newRel },
    edits,
    dryRun,
  };
  if (dryRun) return report;

  // Same device, atomic; gitignored content under the item (e.g. local/)
  // moves along because the directory inode is renamed whole.
  await fs.rename(oldDir, newDir);

  for (const plan of plans) {
    const abs = join(conceptionPath, reportPath(plan.file));
    // Serialise against the GUI's mutation writers per path, like
    // rewriteHeadersInTree (internals invariant 2).
    const content = plan.content;
    await withFileQueue(abs, () => atomicWrite(abs, content));
  }

  // Same engine `condash projects index` runs — bullets re-derive from the
  // moved tree rather than a textual patch of a generated file. The new
  // folder name is a confirmed rename: without it the engine would only flag
  // the old→new bullet pair as "suspected" and leave the item out of its
  // month index until a second run.
  const indexRegen: IndexRegenReport = await regenerateIndex(conceptionPath, projectsStrategy, {
    confirmedRenames: new Set([newFolder]),
  });
  report.indexes = {
    tree: 'projects',
    created: indexRegen.created.length,
    updated: indexRegen.updated.length,
    unchanged: indexRegen.unchanged.length,
  };

  // Mutating-verb convention: mark the tree dirty so any consumer that skips
  // its own regen still sees one waiting.
  await touchDirtyMarker(conceptionPath, 'projects');

  return report;
}
