import type { ResourceCategory } from './types';

/**
 * Coarse file classification shared between the main-process resources walk
 * (`main/resources.ts`) and the renderer's file-open router
 * (`renderer/deliverable-open.ts`). Kept node-free (a local `extLower` instead
 * of `node:path`) so the renderer bundle can import it.
 *
 * One source of truth means a `.css` resolves to `text` — and opens the same
 * way — whether the Resources pane or a deliverable link asked for it.
 */

/** Lowercased extension including the dot (e.g. `.css`), or `''` when there is
 *  none. Matches `node:path.extname` semantics: a leading-dot name like `.env`
 *  has no extension. */
function extLower(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

/**
 * Coarse category from the filename extension. Drives the icon picker and which
 * in-app viewer (or external fallback) a file opens in. Every entry maps to one
 * bucket; unknown extensions fall through to `other`.
 */
export function categorise(name: string): ResourceCategory {
  const ext = extLower(name);
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.mdx') return 'mdx';
  if (ext === '.pdf') return 'pdf';
  if (HTML_EXTS.has(ext)) return 'html';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (BINARY_EXTS.has(ext)) return 'binary';
  return 'other';
}

/**
 * Best-effort mime hint. Kept compact rather than pulling in `mime-types`; the
 * renderer only uses this for tooltips, the category drives behaviour.
 */
export function mimeFor(name: string): string | undefined {
  return MIME_TABLE[extLower(name)];
}

const HTML_EXTS = new Set(['.html', '.htm']);

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
  '.mdx': 'text/mdx',
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
