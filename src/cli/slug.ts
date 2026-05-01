import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { itemFolderRegex } from '../shared/header';
import { ambiguous, notFound } from './output';

const FOLDER_NAME_RE = itemFolderRegex();

export interface SlugCandidate {
  slug: string;
  /** Path to the README.md inside the matched folder. */
  readmePath: string;
  /** Absolute path of the matched item folder. */
  itemDir: string;
  /** Path relative to the conception root, e.g. `projects/2026-05/2026-05-01-foo`. */
  relPath: string;
}

/**
 * Resolve a slug shorthand to a single item folder per the rules in
 * `projects/SKILL.md`'s "Slug resolution" section. Throws `NOT_FOUND` (exit 4)
 * on zero matches and `AMBIGUOUS` (exit 6) on multiple matches; the AMBIGUOUS
 * payload carries the full candidate list so the skill can re-prompt with a
 * more specific value.
 */
export async function resolveSlug(conceptionPath: string, slug: string): Promise<SlugCandidate> {
  const normalised = slug.trim().replace(/\/$/, '');
  if (!normalised) {
    notFound('Slug is empty');
  }

  // Month-qualified form: `2026-05/2026-05-01-foo`.
  const slashIdx = normalised.indexOf('/');
  if (slashIdx !== -1) {
    const [month, item] = [normalised.slice(0, slashIdx), normalised.slice(slashIdx + 1)];
    const itemDir = join(conceptionPath, 'projects', month, item);
    const readmePath = join(itemDir, 'README.md');
    if (await isFile(readmePath)) {
      return { slug: item, readmePath, itemDir, relPath: relative(conceptionPath, itemDir) };
    }
    notFound(`No README at projects/${month}/${item}/README.md`, { slug: normalised });
  }

  const candidates = await findCandidates(conceptionPath, normalised);
  if (candidates.length === 0) {
    notFound(`No item matches slug '${slug}'`, { slug });
  }
  if (candidates.length === 1) return candidates[0];
  ambiguous(
    `Slug '${slug}' matches ${candidates.length} items`,
    candidates.map((c) => ({ slug: c.slug, relPath: c.relPath })),
  );
}

async function findCandidates(conceptionPath: string, slug: string): Promise<SlugCandidate[]> {
  const projectsRoot = join(conceptionPath, 'projects');
  const months = await readDirs(projectsRoot);
  const matches: SlugCandidate[] = [];
  for (const month of months) {
    const itemDirs = await readDirs(join(projectsRoot, month));
    for (const item of itemDirs) {
      if (!matchesSlug(item, slug)) continue;
      const itemDir = join(projectsRoot, month, item);
      const readmePath = join(itemDir, 'README.md');
      if (!(await isFile(readmePath))) continue;
      matches.push({
        slug: item,
        readmePath,
        itemDir,
        relPath: relative(conceptionPath, itemDir),
      });
    }
  }
  return matches;
}

function matchesSlug(folderName: string, query: string): boolean {
  if (folderName === query) return true;
  // Full dated form passed without a month: glob-equivalent of `*/<query>`.
  if (FOLDER_NAME_RE.test(query) && folderName === query) return true;
  // Short form: any part of the slug after the date prefix.
  const afterDate = folderName.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  return (
    afterDate === query ||
    afterDate.includes(`-${query}`) ||
    afterDate.startsWith(`${query}-`) ||
    afterDate.includes(query)
  );
}

async function readDirs(dir: string): Promise<string[]> {
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

async function isFile(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}

export { isItemFolderName, itemFolderRegex } from '../shared/header';
export { dirname };
