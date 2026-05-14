import { promises as fs } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { COMPILE_TARGETS, type Skillspec } from './types';

/** Top-level entries the parser owns; everything else is a sibling asset. */
const RESERVED_TOP = new Set(['spec.yaml', 'body.md', 'targets']);

export class SkillspecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillspecError';
  }
}

/**
 * Parse a skillspec source directory at `sourceDir` into a normalized
 * Skillspec. Throws SkillspecError if required files are missing or YAML
 * is malformed; bubbles up filesystem errors otherwise.
 */
export async function parseSkillspec(sourceDir: string): Promise<Skillspec> {
  const name = basename(sourceDir);

  const spec = await readMappingFile(join(sourceDir, 'spec.yaml'), { required: true });
  if (typeof spec.description !== 'string' || spec.description.trim() === '') {
    throw new SkillspecError(
      `${join(sourceDir, 'spec.yaml')}: required field 'description' is missing or empty`,
    );
  }

  const bodyPath = join(sourceDir, 'body.md');
  let body: string;
  try {
    body = await fs.readFile(bodyPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SkillspecError(`Missing required file: ${bodyPath}`);
    }
    throw err;
  }

  const targets: Skillspec['targets'] = {};
  for (const t of COMPILE_TARGETS) {
    const overlayPath = join(sourceDir, 'targets', `${t}.yaml`);
    const overlay = await readMappingFile(overlayPath, { required: false });
    if (overlay !== null) targets[t] = overlay;
  }

  const assets: Record<string, Buffer> = {};
  await collectAssets(sourceDir, sourceDir, assets);

  return { name, sourceDir, spec, body, targets, assets };
}

async function readMappingFile(
  path: string,
  opts: { required: true },
): Promise<Record<string, unknown>>;
async function readMappingFile(
  path: string,
  opts: { required: false },
): Promise<Record<string, unknown> | null>;
async function readMappingFile(
  path: string,
  opts: { required: boolean },
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (opts.required) {
        throw new SkillspecError(`Missing required file: ${path}`);
      }
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new SkillspecError(`Failed to parse ${path}: ${(err as Error).message}`);
  }

  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillspecError(`${path}: expected a YAML mapping at the top level`);
  }
  return parsed as Record<string, unknown>;
}

async function collectAssets(
  rootDir: string,
  current: string,
  out: Record<string, Buffer>,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (current === rootDir && RESERVED_TOP.has(entry.name)) continue;
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      await collectAssets(rootDir, abs, out);
    } else if (entry.isFile()) {
      const rel = normalizePosix(relative(rootDir, abs));
      out[rel] = await fs.readFile(abs);
    }
  }
}

function normalizePosix(rel: string): string {
  return rel.split(/[\\/]/).join('/');
}
