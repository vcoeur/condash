import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const KNOWLEDGE_IGNORED = /(^|\/)\.[^/]+/;

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
    if (KNOWLEDGE_IGNORED.test(file)) return;
    out.push(file);
  });
  return out;
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
      await walkMarkdown(full, visit);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      visit(full);
    }
  }
}
