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

export function renderMarkdown(input: string): string {
  return md.render(input);
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
