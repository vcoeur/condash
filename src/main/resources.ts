import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ResourceCategory, ResourceNode } from '../shared/types';
import { toPosix } from '../shared/path';
import { DEFAULT_RESOURCES_PATH } from './config-schema';
import { parseHead } from './knowledge';
import { readFileHead } from './read-file-head';

const HIDDEN_PREFIX = /^\./;

/**
 * Read the resources tree at `<conceptionPath>/resources/`. Unlike
 * `readKnowledgeTree`, every file is surfaced regardless of extension —
 * the renderer decides what to do with it based on `category`. Symlink
 * loops are deduped via realpath, same as Knowledge. The directory name
 * is hard-coded since the reframe (no `resources_path` override).
 */
export async function readResourcesTree(conceptionPath: string): Promise<ResourceNode | null> {
  const root = join(conceptionPath, DEFAULT_RESOURCES_PATH);
  try {
    await fs.access(root);
  } catch {
    return null;
  }
  return walk(root, '', DEFAULT_RESOURCES_PATH, new Set<string>());
}

async function walk(
  absPath: string,
  relPath: string,
  name: string,
  visitedDirs: Set<string>,
): Promise<ResourceNode> {
  const stat = await fs.stat(absPath);
  if (stat.isFile()) {
    const category = categorise(name);
    const mime = mimeFor(name);
    let summary: string | undefined;
    let title: string | undefined;
    if (category === 'markdown') {
      const meta = await readMarkdownMeta(absPath, name);
      title = meta.title;
      summary = meta.summary;
    }
    return {
      relPath,
      path: toPosix(absPath),
      name,
      title: title ?? name,
      kind: 'file',
      summary,
      category,
      mime,
      size: stat.size,
    };
  }

  let canonical = absPath;
  try {
    canonical = await fs.realpath(absPath);
  } catch {
    /* fall through with the lexical path */
  }
  if (visitedDirs.has(canonical)) {
    return {
      relPath,
      path: toPosix(absPath),
      name,
      title: relPath ? basename(absPath) : name,
      kind: 'directory',
      children: [],
    };
  }
  const nextVisited = new Set(visitedDirs);
  nextVisited.add(canonical);

  const entries = await fs.readdir(absPath, { withFileTypes: true });
  // Skip dot-files; everything else (any extension) is included.
  const accepted = entries.filter((e) => !HIDDEN_PREFIX.test(e.name));

  const children = await Promise.all(
    accepted.map(async (entry) => {
      const childAbs = join(absPath, entry.name);
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      return walk(childAbs, childRel, entry.name, nextVisited);
    }),
  );

  children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    relPath,
    path: toPosix(absPath),
    name,
    title: relPath ? basename(absPath) : name,
    kind: 'directory',
    children,
  };
}

async function readMarkdownMeta(
  path: string,
  fallback: string,
): Promise<{ title: string; summary?: string }> {
  const head = await readFileHead(path);
  if (head === null) return { title: fallback };
  const meta = parseHead(head, fallback);
  return { title: meta.title, summary: meta.summary };
}

/**
 * Coarse category from the filename extension. Drives the icon picker and
 * which "View" action shows on the card. Every entry maps to one bucket;
 * unknown extensions fall through to `other`.
 */
export function categorise(name: string): ResourceCategory {
  const ext = extname(name).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (BINARY_EXTS.has(ext)) return 'binary';
  return 'other';
}

/**
 * Best-effort mime hint. Kept compact rather than pulling in `mime-types`;
 * the renderer only uses this for tooltips, the category drives behaviour.
 */
export function mimeFor(name: string): string | undefined {
  const ext = extname(name).toLowerCase();
  return MIME_TABLE[ext];
}

const TEXT_EXTS = new Set([
  '.txt',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.hh',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.lua',
  '.sql',
  '.r',
  '.swift',
  '.scala',
  '.tex',
]);

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.tiff',
  '.ico',
  '.avif',
  '.heic',
]);

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus']);

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar']);

const BINARY_EXTS = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.iso', '.dmg']);

const MIME_TABLE: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};
