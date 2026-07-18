import type MarkdownIt from 'markdown-it';
import { wikilinks } from './wikilinks';

// markdown-it + highlight.js are the single biggest non-terminal weight in the
// eager renderer bundle (~237 KB / 16 % of the boot chunk). They're only needed
// once the user opens a note / help / html modal, so the engine — the configured
// MarkdownIt instance plus highlight.js/lib/common — is built lazily on first
// render and cached. `renderMarkdown` / `highlightCode` are therefore async; the
// modals already read their content asynchronously, so they await the engine the
// same way. mermaid is loaded lazily too (see `getMermaid`).
type MarkdownEngine = {
  md: MarkdownIt;
  highlight: typeof import('highlight.js/lib/common').default;
};

let enginePromise: Promise<MarkdownEngine> | null = null;

async function getEngine(): Promise<MarkdownEngine> {
  if (!enginePromise) {
    enginePromise = buildEngine();
  }
  return enginePromise;
}

async function buildEngine(): Promise<MarkdownEngine> {
  const [{ default: MarkdownItCtor }, { default: anchor }, taskListsMod, hljsMod] =
    await Promise.all([
      import('markdown-it'),
      import('markdown-it-anchor'),
      import('markdown-it-task-lists'),
      import('highlight.js/lib/common'),
    ]);
  // markdown-it-task-lists is shimmed as an untyped module (any).
  const taskLists = taskListsMod.default;
  const highlight = hljsMod.default;

  const md = new MarkdownItCtor({
    html: false,
    linkify: true,
    breaks: false,
    highlight: (str, lang) => {
      if (lang && highlight.getLanguage(lang)) {
        try {
          return highlight.highlight(str, { language: lang, ignoreIllegals: true }).value;
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

  return { md, highlight };
}

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
 *  relative-image rewriter above and the HTML preview modal. Pure — kept out of
 *  the lazy engine so the image/html modals can import it without pulling
 *  markdown-it. */
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

/** Render markdown to HTML. Async: the markdown-it + highlight.js engine is
 *  lazy-loaded and cached on first call (kept out of the boot chunk). */
export async function renderMarkdown(
  input: string,
  options: RenderMarkdownOptions = {},
): Promise<string> {
  const { md } = await getEngine();
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
 * "Source" tab. Async for the same lazy-engine reason as `renderMarkdown`.
 */
export async function highlightCode(text: string, path: string): Promise<string> {
  const { md, highlight } = await getEngine();
  if (text.length > MAX_HIGHLIGHT_BYTES) {
    return `<pre class="hljs"><code>${md.utils.escapeHtml(text)}</code></pre>`;
  }
  const lang = hljsLangForPath(path);
  if (lang && highlight.getLanguage(lang)) {
    try {
      const { value } = highlight.highlight(text, { language: lang, ignoreIllegals: true });
      return `<pre class="hljs"><code>${value}</code></pre>`;
    } catch {
      /* fall through to plain text */
    }
  }
  return `<pre class="hljs"><code>${md.utils.escapeHtml(text)}</code></pre>`;
}

/**
 * Highlight a snippet by explicit language id (plan blocks carry `language`
 * rather than a path). Unknown/unbundled languages degrade to escaped text.
 */
export async function highlightSnippet(text: string, language?: string): Promise<string> {
  const { md, highlight } = await getEngine();
  if (language && highlight.getLanguage(language) && text.length <= MAX_HIGHLIGHT_BYTES) {
    try {
      return highlight.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      /* fall through to plain text */
    }
  }
  return md.utils.escapeHtml(text);
}

/**
 * Highlight code line by line, returning one HTML string per line. Used by
 * the plan viewer's diff / annotated-code blocks, whose line-anchored
 * annotations need each line addressable. Per-line tokenising loses state
 * that spans lines (an unterminated block comment re-tokenises per line) —
 * an accepted trade-off for anchorable lines.
 */
export async function highlightLines(
  lines: readonly string[],
  language?: string,
): Promise<string[]> {
  const { md, highlight } = await getEngine();
  const canHighlight = Boolean(language && highlight.getLanguage(language));
  return lines.map((line) => {
    if (canHighlight) {
      try {
        return highlight.highlight(line, { language: language!, ignoreIllegals: true }).value;
      } catch {
        /* fall through per line */
      }
    }
    return md.utils.escapeHtml(line);
  });
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
  '.mdx': 'markdown',
};

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

// Monotonic, DOM-safe id for each mermaid.render target (see runMermaidIn).
let mermaidRenderSeq = 0;

/** Reads the resolved dark/light kind rather than the preset id, so every dark
 *  theme gets the dark mermaid palette. `use-theme.ts` stamps `data-theme-kind`
 *  on `<html>` once the renderer hydrates; the OS-preference fallback covers the
 *  pre-hydration window only.
 *
 *  It does **not** cover the note-PDF export: that document renders no mermaid
 *  of its own (the hidden print window runs no scripts), so the diagrams reach
 *  it as SVG already rendered here in the live renderer. What keeps those light
 *  is the explicit `theme: 'default'` override in `renderMarkdownForExport`
 *  below — not this function. Do not drop that override as redundant. */
function activeMermaidTheme(): 'default' | 'dark' {
  const kind = document.documentElement.dataset.themeKind;
  if (kind === 'dark') return 'dark';
  if (kind === 'light') return 'default';
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
 * SVGs keep their colours until the next render. Pure (no markdown-it / hljs
 * dependency) so `use-theme` can import it without pulling the markdown engine.
 */
export function resetMermaidTheme(): void {
  mermaidPromise = null;
}

export async function runMermaidIn(container: HTMLElement): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>('pre.mermaid');
  if (blocks.length === 0) return;

  const mermaid = await getMermaid();
  await renderMermaidBlocks(container, mermaid);
}

/**
 * Render markdown into a print-ready HTML body for PDF export. A fresh render
 * (so view-mode DOM state like find-bar highlights never leaks in) with
 * mermaid diagrams forced to the light theme — a dark-themed SVG would be
 * unreadable on a white page. The shared mermaid singleton is re-initialised
 * back to the live app theme afterwards.
 */
export async function renderMarkdownForExport(
  input: string,
  options: RenderMarkdownOptions = {},
): Promise<string> {
  const html = await renderMarkdown(input, options);
  const container = document.createElement('div');
  container.innerHTML = html;
  if (container.querySelector('pre.mermaid')) {
    const mermaid = await getMermaid();
    mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
    try {
      await renderMermaidBlocks(container, mermaid);
    } finally {
      mermaid.initialize({
        startOnLoad: false,
        theme: activeMermaidTheme(),
        securityLevel: 'strict',
      });
    }
  }
  return container.innerHTML;
}

async function renderMermaidBlocks(
  container: HTMLElement,
  mermaid: Awaited<ReturnType<typeof getMermaid>>,
): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>('pre.mermaid');
  for (const block of blocks) {
    // This effect re-runs on every html()/theme change; once a block has been
    // turned into an SVG, skip it so we don't re-parse rendered output as source.
    if (block.dataset.processed) continue;
    const source = block.textContent ?? '';
    if (!source.trim()) continue;
    try {
      // Render via mermaid.render, not mermaid.run. run() measures each node
      // label inside `block` with getBoundingClientRect (screen space); the note
      // and help modals mount mermaid while their `modal-in` scale() animation is
      // live, so every node box is sized to the transformed (shrunken) text and
      // then clips once the animation settles to scale(1). render() measures in a
      // throwaway element on the untransformed <body>, so box widths are correct
      // regardless of any ancestor transform. See issue #319.
      const id = `condash-mermaid-${(mermaidRenderSeq += 1)}`;
      const { svg, bindFunctions } = await mermaid.render(id, source);
      block.innerHTML = svg;
      block.dataset.processed = 'true';
      bindFunctions?.(block);
    } catch (err) {
      console.error('[mermaid]', err);
    }
  }
}
