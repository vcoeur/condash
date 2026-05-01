import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { toPosix } from '../shared/path';

export async function readNote(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Surface an empty file for editor flows (preferences) where the file may
      // not exist yet; the writeNote drift check uses the same empty string as
      // the "expected on disk" baseline so a first-save creates the file.
      return '';
    }
    throw err;
  }
}

/** Sanitise a user-provided slug into the lowercase-hyphen shape used by
 * `notes/NN-<slug>.md`. */
function sanitiseSlug(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'note';
}

/** Find the next free `NN-` prefix in `notes/`. Files are scanned for a leading
 * two-digit prefix; counter is `max(found) + 1`, starting from `01`. */
async function nextNotePrefix(notesDir: string): Promise<string> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(notesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let maxIndex = 0;
  for (const name of entries) {
    const match = /^(\d{2})-/.exec(name);
    if (!match) continue;
    const idx = Number(match[1]);
    if (Number.isFinite(idx) && idx > maxIndex) maxIndex = idx;
  }
  const next = maxIndex + 1;
  return next.toString().padStart(2, '0');
}

/** Create a new note file under `<projectPath>/notes/NN-<slug>.md`. The
 * project README path may also be passed; we coerce to its parent folder.
 * Returns the absolute path written. */
export async function createProjectNote(projectPath: string, slug: string): Promise<string> {
  // Accepts either the project directory or the README inside it. Use
  // `path.dirname` rather than slicing a fixed `'/README.md'.length` so
  // Windows separators (`\README.md`) don't throw off the slice.
  const projectDir =
    basename(projectPath).toLowerCase() === 'readme.md' ? dirname(projectPath) : projectPath;
  const notesDir = join(projectDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  const cleaned = sanitiseSlug(slug);
  const prefix = await nextNotePrefix(notesDir);
  const filename = `${prefix}-${cleaned}.md`;
  const path = join(notesDir, filename);
  // Title-case the slug for the H1 heading.
  const title = cleaned
    .split('-')
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
  const projectName = basename(projectDir);
  const body = `# ${prefix} — ${title}\n\n> Created in ${projectName}.\n\n`;
  await fs.writeFile(path, body, { encoding: 'utf8', flag: 'wx' });
  return toPosix(path);
}
