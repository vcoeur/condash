import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ConceptionInitState } from '../shared/types';

/**
 * Path to the bundled conception-template/ tree. Resolved from the app's
 * source root in dev (`app.getAppPath()`), and from the asar archive in
 * packaged builds (electron-builder copies `conception-template/**` per
 * `electron-builder.yml`).
 */
function templateRoot(): string {
  return join(app.getAppPath(), 'conception-template');
}

/** Probe a candidate workspace path for the conception markers. */
export async function detectConceptionState(path: string): Promise<ConceptionInitState> {
  let pathExists = false;
  try {
    const stat = await fs.stat(path);
    pathExists = stat.isDirectory();
  } catch {
    pathExists = false;
  }

  if (!pathExists) {
    return {
      pathExists: false,
      hasProjects: false,
      hasConfiguration: false,
      looksInitialised: false,
    };
  }

  const hasProjects = await isDirectory(join(path, 'projects'));
  const hasConfiguration = await isFile(join(path, 'configuration.json'));
  return {
    pathExists: true,
    hasProjects,
    hasConfiguration,
    looksInitialised: hasProjects && hasConfiguration,
  };
}

/**
 * Copy the bundled conception-template/ into `targetPath`, expanding the
 * `*.example` files (`CLAUDE.md.example` → `CLAUDE.md`,
 * `configuration.json.example` → `configuration.json`,
 * `.claude/settings.example.json` → `.claude/settings.json`). Existing
 * files are preserved — the init never overwrites.
 *
 * Returns the list of paths that were created (relative to `targetPath`).
 */
export async function initConception(targetPath: string): Promise<string[]> {
  const src = templateRoot();
  await ensureDir(targetPath);
  const created: string[] = [];
  await copyTreeRespecting(src, targetPath, '', created);
  return created;
}

async function copyTreeRespecting(
  srcRoot: string,
  dstRoot: string,
  rel: string,
  created: string[],
): Promise<void> {
  const srcDir = join(srcRoot, rel);
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcRel = rel ? `${rel}/${entry.name}` : entry.name;
    const dstRel = mapTemplateName(srcRel);
    const srcAbs = join(srcRoot, srcRel);
    const dstAbs = join(dstRoot, dstRel);
    if (entry.isDirectory()) {
      await ensureDir(dstAbs);
      await copyTreeRespecting(srcRoot, dstRoot, srcRel, created);
      continue;
    }
    if (await pathExists(dstAbs)) continue;
    await ensureDir(dirname(dstAbs));
    await fs.copyFile(srcAbs, dstAbs);
    if (entry.name.endsWith('.sh')) {
      await fs.chmod(dstAbs, 0o755);
    }
    created.push(dstRel);
  }
}

/** Drop the `.example` suffix on the three known templated files. */
function mapTemplateName(rel: string): string {
  if (rel === 'CLAUDE.md.example') return 'CLAUDE.md';
  if (rel === 'configuration.json.example') return 'configuration.json';
  if (rel === '.claude/settings.example.json') return '.claude/settings.json';
  return rel;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}
