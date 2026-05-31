import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js/lib/common';
import { wikilinks } from './wikilinks';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* fall through */
      }
    }
    return '';
  },
})
  .use(anchor, { permalink: false })
  .use(taskLists, { enabled: false })
  .use(wikilinks);

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
  const token = tokens[idx];
  if (token.info.trim().toLowerCase() === 'mermaid') {
    const content = md.utils.escapeHtml(token.content);
    return `<pre class="mermaid">${content}</pre>\n`;
  }
  return defaultFence(tokens, idx, options, env, slf);
};

// Rewrite relative `<img src>` to a `condash-file:///abs-path` URL so the
// custom protocol handler in main/index.ts can serve it. Without this, the
// renderer's CSP + Chromium's cross-origin file:// policy silently drops the
// image and falls back to alt text — see issue #85.
const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, slf) => {
  const token = tokens[idx];
  const baseDir = (env as { baseDir?: string }).baseDir;
  if (baseDir) {
    const srcIdx = token.attrIndex('src');
    if (srcIdx >= 0 && token.attrs) {
      const src = token.attrs[srcIdx][1];
      if (isRelativeAssetPath(src)) {
        token.attrs[srcIdx][1] = relativeToCondashFile(baseDir, src);
      }
    }
  }
  return defaultImage(tokens, idx, options, env, slf);
};

function isRelativeAssetPath(src: string): boolean {
  if (!src) return false;
  // Skip URLs with a scheme, protocol-relative URLs, root-anchored paths,
  // and inline data:/blob: payloads. Everything else is a relative path
  // we should resolve against the note's directory.
  if (/^[a-z][a-z0-9+\-.]*:/i.test(src)) return false;
  if (src.startsWith('//')) return false;
  if (src.startsWith('/')) return false;
  if (src.startsWith('#')) return false;
  return true;
}

function relativeToCondashFile(baseDir: string, src: string): string {
  // baseDir is the absolute path to the note's directory. We posix-join the
  // relative src against it (paths crossing the IPC boundary are normalised
  // to forward-slash form already), URI-encode each segment, and emit a
  // `condash-file:///<abs>` URL. The triple-slash means "no host" so the
  // pathname carries the full absolute path.
  const segments = src.split('/').filter((s) => s !== '' && s !== '.');
  const baseSegments = baseDir.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '..') baseSegments.pop();
    else baseSegments.push(seg);
  }
  return pathToCondashFileUrl(baseSegments.join('/'));
}

/** Build a `condash-file:///<abs>` URL for an absolute path (posix or native).
 *  Each path segment is URI-encoded; the triple slash means "no host" so the
 *  pathname carries the full absolute path. The custom protocol handler in
 *  main/index.ts serves it from inside the conception tree. Shared by the
 *  relative-image rewriter above and the HTML preview modal. */
export function pathToCondashFileUrl(absPath: string): string {
  const encoded = absPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `condash-file:///${encoded}`;
}

export interface RenderMarkdownOptions {
  /** Absolute path of the directory the markdown lives in. When set, relative
   *  image srcs are rewritten to `condash-file://` so images outside the
   *  renderer's origin can load. Wikilinks/markdown links are unaffected. */
  baseDir?: string;
}

export function renderMarkdown(input: string, options: RenderMarkdownOptions = {}): string {
  return md.render(input, { baseDir: options.baseDir });
}

// Above this size highlighting a single file is dropped to escaped plain text:
// hljs runs synchronously, and tokenising a multi-hundred-KB file blows the
// 16 ms interaction-to-paint budget. The text stays readable, just uncoloured.
const MAX_HIGHLIGHT_BYTES = 200_000;

/** Map a file path's extension to a highlight.js language id. Anything not
 *  listed (or not bundled in `highlight.js/lib/common`) falls back to escaped
 *  plain text in `highlightCode`. */
function hljsLangForPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return undefined;
  return HLJS_LANG_BY_EXT[lower.slice(dot)];
}

/**
 * Render a non-markdown text/code file as a syntax-highlighted `<pre><code>`
 * block. Language is inferred from the extension; unknown or unbundled
 * languages (and over-large files) degrade to escaped plain text. The `.hljs`
 * classes are themed by `code-theme.css`, the same palette the markdown fenced
 * code blocks use. Used by the note modal's read-only view and the HTML modal's
 * "Source" tab.
 */
export function highlightCode(text: string, path: string): string {
  if (text.length > MAX_HIGHLIGHT_BYTES) {
    return `<pre class="hljs"><code>${md.utils.escapeHtml(text)}</code></pre>`;
  }
  const lang = hljsLangForPath(path);
  if (lang && hljs.getLanguage(lang)) {
    try {
      const { value } = hljs.highlight(text, { language: lang, ignoreIllegals: true });
      return `<pre class="hljs"><code>${value}</code></pre>`;
    } catch {
      /* fall through to plain text */
    }
  }
  return `<pre class="hljs"><code>${md.utils.escapeHtml(text)}</code></pre>`;
}

const HLJS_LANG_BY_EXT: Record<string, string> = {
  '.js': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'scss',
  '.less': 'less',
  '.html': 'xml',
  '.htm': 'xml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.env': 'ini',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.hh': 'cpp',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.sql': 'sql',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

function activeMermaidTheme(): 'default' | 'dark' {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark') return 'dark';
  if (explicit === 'light') return 'default';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
}

async function getMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: activeMermaidTheme(),
        securityLevel: 'strict',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/**
 * Drop the cached Mermaid instance so the next runMermaidIn re-initialises with
 * the current theme. Newly rendered diagrams pick up the theme; existing rendered
 * SVGs keep their colours until the next render.
 */
export function resetMermaidTheme(): void {
  mermaidPromise = null;
}

export async function runMermaidIn(container: HTMLElement): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>('pre.mermaid');
  if (blocks.length === 0) return;

  const mermaid = await getMermaid();
  // mermaid.run rewrites blocks in place; mark them so it doesn't double-run.
  for (const block of blocks) {
    if (!block.dataset.processed) {
      block.dataset.processed = '';
    }
  }
  await mermaid.run({ nodes: Array.from(blocks) }).catch((err) => {
    console.error('[mermaid]', err);
  });
}
