import type MarkdownIt from 'markdown-it';
import type { KnowledgeNode, Project } from '@shared/types';

export interface WikiTarget {
  path: string;
  title: string;
}

const SLUG_BOUNDARY = /[A-Za-z0-9_-]/;

/**
 * Flatten the projects + knowledge trees into a slug → target[] map. Multiple
 * matches are kept so the modal can disambiguate (or pick a default).
 */
export function buildSlugIndex(
  projects: readonly Project[],
  knowledgeRoot: KnowledgeNode | null,
): Map<string, WikiTarget[]> {
  const idx = new Map<string, WikiTarget[]>();

  const push = (slug: string, target: WikiTarget): void => {
    const existing = idx.get(slug);
    if (existing) existing.push(target);
    else idx.set(slug, [target]);
  };

  for (const p of projects) {
    push(p.slug, { path: p.path, title: p.title });
    const stripped = stripDatePrefix(p.slug);
    if (stripped !== p.slug) push(stripped, { path: p.path, title: p.title });
  }

  if (knowledgeRoot) {
    walkKnowledge(knowledgeRoot, push);
  }

  return idx;
}

function stripDatePrefix(slug: string): string {
  return slug.replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

function walkKnowledge(
  node: KnowledgeNode,
  push: (slug: string, target: WikiTarget) => void,
): void {
  if (node.kind === 'file') {
    const base = node.name.replace(/\.md$/i, '');
    push(base, { path: node.path, title: node.title });
  } else if (node.children) {
    for (const child of node.children) walkKnowledge(child, push);
  }
}

/**
 * markdown-it inline rule. Matches [[slug]] (slug = letters / digits / _ / -)
 * and emits an `<a class="wikilink" data-slug="…">[[slug]]</a>` link.
 */
export function wikilinks(md: MarkdownIt): void {
  md.inline.ruler.before('emphasis', 'wikilink', (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x5b) return false; // '['
    if (state.src.charCodeAt(start + 1) !== 0x5b) return false;

    let pos = start + 2;
    while (pos < state.posMax) {
      const ch = state.src[pos];
      if (ch === ']' && state.src[pos + 1] === ']') break;
      if (!SLUG_BOUNDARY.test(ch)) return false;
      pos++;
    }
    if (pos >= state.posMax) return false;

    const slug = state.src.slice(start + 2, pos);
    if (slug.length === 0) return false;

    if (!silent) {
      const open = state.push('link_open', 'a', 1);
      open.attrs = [
        ['class', 'wikilink'],
        ['data-slug', slug],
        ['href', '#'],
      ];
      const text = state.push('text', '', 0);
      text.content = `[[${slug}]]`;
      state.push('link_close', 'a', -1);
    }

    state.pos = pos + 2;
    return true;
  });
}
