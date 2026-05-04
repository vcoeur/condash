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
  const encoded = baseSegments.map((s) => encodeURIComponent(s)).join('/');
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
