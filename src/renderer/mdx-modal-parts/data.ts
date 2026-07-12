import type { CodeAnnotation, FileTreeEntry, KitNode } from '@shared/plan-blocks/schemas';

/**
 * Pure logic for the plan/recap viewer blocks: line-range parsing, diff row
 * pairing, file-tree building, legacy kit-tree → HTML mapping, and CSS
 * scoping. No DOM, no Solid, no heavy deps — tested in `data.test.ts`.
 */

/** Parse an annotation line range (`"12"` or `"12-18"`) to inclusive bounds. */
export function parseLineRange(range: string): { start: number; end: number } | null {
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(range.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] !== undefined ? Number(match[2]) : start;
  return end >= start ? { start, end } : { start: end, end: start };
}

/** Line numbers (1-indexed) an annotation set covers, per side. */
export function annotatedLines(
  annotations: readonly CodeAnnotation[] | undefined,
  side: 'before' | 'after',
): Set<number> {
  const out = new Set<number>();
  for (const annotation of annotations ?? []) {
    if ((annotation.side ?? 'after') !== side) continue;
    const range = parseLineRange(annotation.lines);
    if (!range) continue;
    for (let line = range.start; line <= range.end; line += 1) out.add(line);
  }
  return out;
}

/** One line-diff change part, structurally matching jsdiff's `Change`. */
export interface DiffChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export type DiffRowKind = 'context' | 'added' | 'removed';

/** One side of a split-diff row (absent on the opposite side of an add/remove). */
export interface DiffCell {
  num: number;
  text: string;
  kind: DiffRowKind;
}

export interface SplitDiffRow {
  left?: DiffCell;
  right?: DiffCell;
}

export interface UnifiedDiffRow {
  numBefore?: number;
  numAfter?: number;
  text: string;
  kind: DiffRowKind;
}

function changeLines(change: DiffChange): string[] {
  const lines = change.value.split('\n');
  // A trailing newline produces one empty trailing element — not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Pair jsdiff line changes into side-by-side rows: a removed run aligns with
 * the added run that follows it (the modify case); unpaired lines leave the
 * other cell empty.
 */
export function computeSplitRows(changes: readonly DiffChange[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let leftNum = 1;
  let rightNum = 1;
  let index = 0;
  while (index < changes.length) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      for (const text of changeLines(change)) {
        rows.push({
          left: { num: leftNum++, text, kind: 'context' },
          right: { num: rightNum++, text, kind: 'context' },
        });
      }
      index += 1;
      continue;
    }
    const removed = change.removed ? changeLines(change) : [];
    let added: string[] = [];
    let consumed = 1;
    if (change.removed && changes[index + 1]?.added) {
      added = changeLines(changes[index + 1]);
      consumed = 2;
    } else if (change.added) {
      added = changeLines(change);
    }
    const height = Math.max(removed.length, added.length);
    for (let i = 0; i < height; i += 1) {
      rows.push({
        left:
          i < removed.length ? { num: leftNum++, text: removed[i], kind: 'removed' } : undefined,
        right: i < added.length ? { num: rightNum++, text: added[i], kind: 'added' } : undefined,
      });
    }
    index += consumed;
  }
  return rows;
}

/** Flatten jsdiff line changes into unified-view rows. */
export function computeUnifiedRows(changes: readonly DiffChange[]): UnifiedDiffRow[] {
  const rows: UnifiedDiffRow[] = [];
  let beforeNum = 1;
  let afterNum = 1;
  for (const change of changes) {
    for (const text of changeLines(change)) {
      if (change.added) rows.push({ numAfter: afterNum++, text, kind: 'added' });
      else if (change.removed) rows.push({ numBefore: beforeNum++, text, kind: 'removed' });
      else rows.push({ numBefore: beforeNum++, numAfter: afterNum++, text, kind: 'context' });
    }
  }
  return rows;
}

/** Directory node built from slash-delimited file-tree entry paths. */
export interface FileTreeNode {
  name: string;
  path: string;
  children: FileTreeNode[];
  entry?: FileTreeEntry;
}

/** Fold flat entries into a directory tree, preserving entry order within a dir. */
export function buildFileTree(entries: readonly FileTreeEntry[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const byPath = new Map<string, FileTreeNode>();
  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean);
    let parentList = roots;
    let prefix = '';
    for (let i = 0; i < segments.length; i += 1) {
      prefix = prefix === '' ? segments[i] : `${prefix}/${segments[i]}`;
      let node = byPath.get(prefix);
      if (!node) {
        node = { name: segments[i], path: prefix, children: [] };
        byPath.set(prefix, node);
        parentList.push(node);
      }
      if (i === segments.length - 1) node.entry = entry;
      parentList = node.children;
    }
  }
  return roots;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch]);
}

/** Legacy kit elements → semantic HTML the wireframe CSS already themes. The
 *  mapping is best-effort display of old screens; new screens carry `html`. */
export function kitNodesToHtml(nodes: readonly KitNode[]): string {
  return nodes.map(kitNodeToHtml).join('');
}

function textProp(props: Record<string, unknown>): string {
  const value = props.text ?? props.label ?? props.title ?? '';
  return escapeHtml(String(value));
}

function kitNodeToHtml(node: KitNode): string {
  const inner = kitNodesToHtml(node.children);
  const text = textProp(node.props);
  switch (node.el) {
    case 'Title':
      return `<h3>${text}</h3>`;
    case 'Text':
    case 'Label':
      return `<p>${text}</p>`;
    case 'Muted':
      return `<p class="wf-muted">${text}</p>`;
    case 'Btn':
    case 'Button':
      return `<button${node.props.primary ? ' class="primary"' : ''}>${text}</button>`;
    case 'Pill':
    case 'Chip':
      return `<span class="wf-pill${node.props.accent ? ' accent' : ''}">${text}</span>`;
    case 'Input':
      return `<input value="${text}" />`;
    case 'Card':
    case 'Box':
      return `<div class="wf-card">${text}${inner}</div>`;
    case 'Row':
      return `<div style="display:flex;gap:10px;align-items:flex-start">${inner}</div>`;
    case 'Sidebar':
      return `<aside style="display:flex;flex-direction:column;gap:6px;min-width:130px">${inner}</aside>`;
    case 'Main':
      return `<main style="flex:1;display:flex;flex-direction:column;gap:8px">${inner}</main>`;
    case 'NavItem':
      return `<div class="wf-kit-nav${node.props.active ? ' active' : ''}">${text}</div>`;
    case 'Lines': {
      const count = typeof node.props.n === 'number' ? Math.min(node.props.n, 12) : 3;
      return Array.from(
        { length: count },
        (_, i) => `<div class="wf-kit-line" style="width:${90 - i * 12}%"></div>`,
      ).join('');
    }
    case 'FrameScreen':
      return `<div class="wf-card">${text}${inner}</div>`;
    default:
      // Unknown kit element: show its text and children in a plain box so
      // the screen still communicates layout intent.
      return `<div class="wf-box">${text}${inner}</div>`;
  }
}

/**
 * Prefix every top-level selector in an author-supplied CSS string with the
 * given scope selector so diagram/custom-html styles can't leak into the app.
 * Handles plain rules and one level of `@media`/`@supports` nesting; other
 * at-rules (`@import`, `@font-face`, `@keyframes`) are dropped — plan visuals
 * have no business loading resources or declaring fonts.
 */
export function scopeCss(css: string, scope: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return scopeRuleList(withoutComments, scope);
}

function scopeRuleList(css: string, scope: string): string {
  const out: string[] = [];
  let rest = css;
  while (rest.trim() !== '') {
    const braceStart = rest.indexOf('{');
    if (braceStart === -1) break;
    const header = rest.slice(0, braceStart).trim();
    const bodyEnd = matchingBrace(rest, braceStart);
    if (bodyEnd === -1) break;
    const body = rest.slice(braceStart + 1, bodyEnd);
    rest = rest.slice(bodyEnd + 1);
    if (header.startsWith('@media') || header.startsWith('@supports')) {
      out.push(`${header} { ${scopeRuleList(body, scope)} }`);
      continue;
    }
    if (header.startsWith('@')) continue;
    const selectors = header
      .split(',')
      .map((selector) => `${scope} ${selector.trim()}`)
      .join(', ');
    out.push(`${selectors} { ${body.trim()} }`);
  }
  return out.join('\n');
}

/** Index of the `}` closing the `{` at `openIndex`, or -1 when unbalanced. */
function matchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Parse a JSON example string for the explorer; error text on failure. */
export function tryParseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
