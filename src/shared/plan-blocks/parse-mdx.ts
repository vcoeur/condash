import { fromMarkdown } from 'mdast-util-from-markdown';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import type { Root, RootContent } from 'mdast';
import type {
  MdxJsxAttribute,
  MdxJsxAttributeValueExpression,
  MdxJsxFlowElement,
} from 'mdast-util-mdx-jsx';
import { parse as parseYaml } from 'yaml';
import { specForTag } from './registry';
import { evaluateAttributeProgram, NonLiteralError } from './literal-eval';
import {
  DATA_SCHEMAS,
  type KitNode,
  type NestedBlockRef,
  type PlanBlock,
  type PlanDocument,
  type PlanFrontmatter,
  type PlanIssue,
} from './schemas';

/**
 * Parse a plan/review MDX document into its block list — MDX as DATA, never as
 * code. The official MDX grammar (micromark mdxjs extension) produces the
 * tree; attribute expressions are reduced with the static-literal evaluator;
 * each block's data is validated against its zod schema. Failures are
 * per-block: a bad block becomes an `invalid` placeholder plus an issue, and
 * the rest of the document still renders. Only a document-level syntax error
 * (e.g. unclosed JSX) aborts, returning zero blocks and one error issue.
 *
 * Heavy imports (micromark/mdast) load with this module — importers must
 * dynamic-import it (`await import('./parse-mdx')`) to keep it out of the
 * renderer boot chunk and off the CLI cold-start path.
 */
export function parsePlanMdx(source: string): PlanDocument {
  const issues: PlanIssue[] = [];
  const { frontmatter, body, bodyStartLine } = splitFrontmatter(source, issues);

  let tree: Root;
  try {
    tree = fromMarkdown(body, {
      extensions: [mdxjs()],
      mdastExtensions: [mdxFromMarkdown()],
    });
  } catch (err) {
    issues.push({
      severity: 'error',
      message: `MDX syntax error: ${messageOf(err)}`,
      line: syntaxErrorLine(err, bodyStartLine),
    });
    return { frontmatter, blocks: [], issues };
  }

  const state: NormalizeState = {
    body,
    bodyStartLine,
    issues,
    usedIds: new Set(),
    seq: new Map(),
  };
  const blocks = normalizeChildren(tree.children, state);
  return { frontmatter, blocks, issues };
}

interface NormalizeState {
  body: string;
  bodyStartLine: number;
  issues: PlanIssue[];
  usedIds: Set<string>;
  seq: Map<string, number>;
}

/** Leading `---` YAML block → frontmatter object + body + 1-indexed body start line. */
function splitFrontmatter(
  source: string,
  issues: PlanIssue[],
): { frontmatter: PlanFrontmatter; body: string; bodyStartLine: number } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { frontmatter: {}, body: source, bodyStartLine: 1 };
  const body = source.slice(match[0].length);
  const bodyStartLine = match[0].split('\n').length;
  let frontmatter: PlanFrontmatter = {};
  try {
    const parsed: unknown = parseYaml(match[1]);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as PlanFrontmatter;
      const kind: string | undefined = frontmatter.kind;
      if (kind === 'recap') {
        // Back-compat: `recap` was renamed to `review` in v4.81.0. Accept it
        // for one release — warn and normalize so the rest of the app (viewer
        // pill, CLI report) only ever sees `review`.
        issues.push({
          severity: 'warning',
          message: 'frontmatter kind "recap" is deprecated — use "review"',
          line: 1,
        });
        frontmatter.kind = 'review';
      } else if (kind !== undefined && kind !== 'plan' && kind !== 'review') {
        issues.push({
          severity: 'warning',
          message: `frontmatter kind should be "plan" or "review" (got ${JSON.stringify(kind)})`,
          line: 1,
        });
      }
    } else {
      issues.push({ severity: 'warning', message: 'frontmatter is not a YAML mapping', line: 1 });
    }
  } catch (err) {
    issues.push({
      severity: 'warning',
      message: `frontmatter YAML failed to parse: ${messageOf(err)}`,
      line: 1,
    });
  }
  return { frontmatter, body, bodyStartLine };
}

/** Normalize a flow-content child list (document root or a Column's children)
 *  into blocks: known capitalized JSX → typed blocks, everything else grouped
 *  into rich-text prose runs sliced verbatim from the source. */
function normalizeChildren(children: readonly RootContent[], state: NormalizeState): PlanBlock[] {
  const blocks: PlanBlock[] = [];
  let proseRun: RootContent[] = [];

  const flushProse = (): void => {
    if (proseRun.length === 0) return;
    const first = proseRun[0];
    const last = proseRun[proseRun.length - 1];
    const start = first.position?.start.offset;
    const end = last.position?.end.offset;
    proseRun = [];
    if (start === undefined || end === undefined) return;
    const markdown = state.body.slice(start, end).trim();
    if (markdown === '') return;
    blocks.push({ type: 'rich-text', id: nextId(state, 'prose'), data: { markdown } });
  };

  for (const node of children) {
    if (node.type === 'mdxjsEsm') {
      state.issues.push({
        severity: 'error',
        message: 'import/export statements are not part of the plan dialect — removed from render',
        line: lineOf(node, state),
      });
      continue;
    }
    if (node.type === 'mdxFlowExpression') {
      state.issues.push({
        severity: 'warning',
        message: 'flow expression `{…}` ignored — plan documents carry data, not code',
        line: lineOf(node, state),
      });
      continue;
    }
    if (node.type === 'mdxJsxFlowElement') {
      const name = node.name;
      // Lowercase / fragment JSX reads as inline HTML-ish prose; the markdown
      // engine escapes it, which is the safe default.
      if (!name || !/^[A-Z]/.test(name)) {
        proseRun.push(node);
        continue;
      }
      flushProse();
      blocks.push(normalizeElement(node, state));
      continue;
    }
    proseRun.push(node);
  }
  flushProse();
  return blocks;
}

/** Normalize one capitalized JSX flow element into a validated block (or an
 *  `invalid` placeholder, never a throw). */
function normalizeElement(el: MdxJsxFlowElement, state: NormalizeState): PlanBlock {
  const tag = el.name as string;
  const line = lineOf(el, state);
  const spec = specForTag(tag);
  if (!spec) {
    state.issues.push({
      severity: 'error',
      message: `unknown block tag <${tag}> — run \`condash mdx blocks\` for the vocabulary`,
      line,
    });
    return invalidBlock(state, tag, `unknown block tag <${tag}>`, sliceOf(el, state));
  }
  if (spec.deprecated) {
    state.issues.push({
      severity: 'warning',
      message: `<${tag}> is deprecated — ${spec.deprecated}`,
      line,
    });
  }

  let props: Record<string, unknown>;
  try {
    props = evaluateAttributes(el.attributes, tag);
  } catch (err) {
    state.issues.push({ severity: 'error', message: `<${tag}>: ${messageOf(err)}`, line });
    return invalidBlock(state, tag, messageOf(err), sliceOf(el, state));
  }

  const rawId = props.id;
  delete props.id;
  const data: Record<string, unknown> = { ...props };

  // Fold MDX children into the type's data field(s).
  if (spec.children === 'markdown') {
    const markdown = childrenSlice(el, state);
    if (markdown) {
      if (spec.type === 'rich-text') data.markdown = markdown;
      else if (spec.type === 'callout') data.body = markdown;
      else if (spec.type === 'api-endpoint') data.description = markdown;
    }
    if (spec.type === 'callout' && typeof data.body !== 'string') data.body = '';
  } else if (spec.children === 'columns') {
    data.columns = normalizeColumns(el, state);
  } else if (spec.children === 'screen') {
    foldScreenChild(el, data, state);
  } else if (spec.type === 'diagram') {
    foldHtmlCssFences(el, data);
  }

  // Validate, then recurse into JSON-carried nested blocks (tabs).
  const schema = DATA_SCHEMAS[spec.type];
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    state.issues.push({ severity: 'error', message: `<${tag}>: ${detail}`, line });
    return invalidBlock(state, tag, detail, sliceOf(el, state));
  }

  const emptiness = emptyPayloadMessage(spec.type, data);
  if (emptiness) {
    state.issues.push({ severity: 'warning', message: `<${tag}>: ${emptiness}`, line });
  }

  if (spec.type === 'tabs' || spec.type === 'code-tabs') {
    validateNestedRefs(data, state, tag, line);
  }

  return { type: spec.type, id: claimId(state, rawId, spec.type, line), data };
}

/** Evaluate a JSX attribute list to a plain props record. Throws NonLiteralError
 *  (or a message-bearing Error) on anything outside the data dialect. */
function evaluateAttributes(
  attributes: MdxJsxFlowElement['attributes'],
  tag: string,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const attr of attributes) {
    if (attr.type !== 'mdxJsxAttribute') {
      throw new NonLiteralError('attribute spread {…}');
    }
    props[attr.name] = evaluateAttributeValue(attr, tag);
  }
  return props;
}

function evaluateAttributeValue(attr: MdxJsxAttribute, tag: string): unknown {
  const value = attr.value;
  if (value === null || value === undefined) return true; // bare attribute
  if (typeof value === 'string') return value;
  const expression = value as MdxJsxAttributeValueExpression;
  const estree = expression.data?.estree;
  if (!estree) {
    throw new Error(`<${tag} ${attr.name}={…}>: expression carried no parse tree`);
  }
  return evaluateAttributeProgram(estree as unknown as { type: string; body: unknown[] });
}

/** Source slice covering an element's children (prose between the tags). */
function childrenSlice(el: MdxJsxFlowElement, state: NormalizeState): string | undefined {
  if (el.children.length === 0) return undefined;
  const start = el.children[0].position?.start.offset;
  const end = el.children[el.children.length - 1].position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  const text = state.body.slice(start, end).trim();
  return text === '' ? undefined : text;
}

/** `<Columns>` children → ColumnsData: each `<Column label>` wraps nested blocks. */
function normalizeColumns(el: MdxJsxFlowElement, state: NormalizeState): unknown[] {
  const columns: unknown[] = [];
  for (const child of el.children) {
    if (child.type !== 'mdxJsxFlowElement' || child.name !== 'Column') {
      // Whitespace/prose between columns is legal MDX; anything substantive is not.
      if (child.type === 'mdxJsxFlowElement') {
        state.issues.push({
          severity: 'warning',
          message: `<Columns> child <${child.name ?? ''}> ignored — only <Column> is valid here`,
          line: lineOf(child, state),
        });
      }
      continue;
    }
    let props: Record<string, unknown>;
    try {
      props = evaluateAttributes(child.attributes, 'Column');
    } catch (err) {
      state.issues.push({
        severity: 'error',
        message: `<Column>: ${messageOf(err)}`,
        line: lineOf(child, state),
      });
      props = {};
    }
    const blocks = normalizeChildren(child.children, state).map(toNestedRef);
    columns.push({
      ...(typeof props.id === 'string' ? { id: props.id } : {}),
      ...(typeof props.label === 'string' ? { label: props.label } : {}),
      blocks,
    });
  }
  return columns;
}

/** `<WireframeBlock><Screen …/></WireframeBlock>` → fold the Screen's props
 *  (surface/html/…) into the wireframe data; legacy kit children become a
 *  preserved `kit` tree for best-effort rendering. */
function foldScreenChild(
  el: MdxJsxFlowElement,
  data: Record<string, unknown>,
  state: NormalizeState,
): void {
  const screen = el.children.find(
    (child): child is MdxJsxFlowElement =>
      child.type === 'mdxJsxFlowElement' && child.name === 'Screen',
  );
  if (!screen) return;
  let props: Record<string, unknown>;
  try {
    props = evaluateAttributes(screen.attributes, 'Screen');
  } catch (err) {
    state.issues.push({
      severity: 'error',
      message: `<Screen>: ${messageOf(err)}`,
      line: lineOf(screen, state),
    });
    return;
  }
  for (const key of ['surface', 'html', 'css', 'caption', 'frame', 'skeleton'] as const) {
    if (props[key] !== undefined && data[key] === undefined) data[key] = props[key];
  }
  // A <Screen> may carry its html/css as ```html / ```css fenced children too
  // (the escape-hatch form, no JSON-string escaping) — same as <Diagram>.
  if (data.html === undefined) foldHtmlCssFences(screen, data);
  const kit = kitTreeOf(screen, state);
  if (kit.length > 0) {
    data.kit = kit;
    state.issues.push({
      severity: 'warning',
      message: 'legacy kit-tree wireframe — new screens should carry a semantic `html` fragment',
      line: lineOf(screen, state),
    });
  }
}

function kitTreeOf(el: MdxJsxFlowElement, state: NormalizeState): KitNode[] {
  const out: KitNode[] = [];
  for (const child of el.children) {
    if (child.type !== 'mdxJsxFlowElement' || !child.name) continue;
    let props: Record<string, unknown>;
    try {
      props = evaluateAttributes(child.attributes, child.name);
    } catch {
      props = {};
    }
    out.push({ el: child.name, props, children: kitTreeOf(child, state) });
  }
  return out;
}

/** Fold ```html / ```css fenced children into data.html/css — the escape-hatch
 *  authoring form shared by `<Diagram>` and `<Screen>` (no attribute escaping). */
function foldHtmlCssFences(el: MdxJsxFlowElement, data: Record<string, unknown>): void {
  for (const child of el.children) {
    if (child.type !== 'code') continue;
    const lang = (child.lang ?? '').toLowerCase();
    if (lang === 'html' && data.html === undefined) data.html = child.value;
    if (lang === 'css' && data.css === undefined) data.css = child.value;
  }
}

/**
 * A schema-valid block can still be visually empty: most visual payloads
 * (`diagram.html`, `code`, `diff.before/after`, `file-tree.entries`) are
 * optional or unbounded, so a green schema check does not verify that anything
 * renders. Return a warning message for a block that would render blank, or
 * null. Surfaced in the viewer banner and by `condash mdx check` so authors
 * catch an unfolded diagram or an empty code attribute before hand-off.
 */
function emptyPayloadMessage(type: string, data: Record<string, unknown>): string | null {
  const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';
  switch (type) {
    case 'diagram':
      return blank(data.html) ? 'no html payload — renders as an empty placeholder' : null;
    case 'custom-html':
      return blank(data.html) ? 'no html payload — renders empty' : null;
    case 'wireframe':
      return blank(data.html) && !(Array.isArray(data.kit) && data.kit.length > 0)
        ? 'no html payload — the screen renders empty'
        : null;
    case 'code':
    case 'annotated-code':
      return blank(data.code) ? 'empty code — renders as a blank block' : null;
    case 'diff':
      return blank(data.before) && blank(data.after)
        ? 'empty before and after — the diff renders blank'
        : null;
    case 'file-tree':
      return Array.isArray(data.entries) && data.entries.length === 0
        ? 'no entries — the tree renders empty'
        : null;
    default:
      return null;
  }
}

/** Validate the {id,type,data} refs a container carries in JSON props,
 *  replacing failures with invalid placeholders (salvage at depth). */
function validateNestedRefs(
  data: Record<string, unknown>,
  state: NormalizeState,
  tag: string,
  line: number | undefined,
): void {
  const groups = data.tabs;
  if (!Array.isArray(groups)) return;
  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue;
    const holder = group as { blocks?: unknown };
    if (!Array.isArray(holder.blocks)) continue;
    holder.blocks = holder.blocks.map((ref) => validateNestedRef(ref, state, tag, line));
  }
}

function validateNestedRef(
  ref: unknown,
  state: NormalizeState,
  tag: string,
  line: number | undefined,
): NestedBlockRef {
  const candidate = ref as NestedBlockRef;
  const schema = DATA_SCHEMAS[candidate.type];
  if (!schema) {
    state.issues.push({
      severity: 'error',
      message: `<${tag}>: nested block type "${candidate.type}" is unknown`,
      line,
    });
    return {
      id: candidate.id ?? nextId(state, 'invalid'),
      type: 'invalid',
      data: { reason: `unknown nested block type "${candidate.type}"` },
    };
  }
  const result = schema.safeParse(candidate.data);
  if (!result.success) {
    const detail = result.error.issues[0];
    const message = `${detail.path.join('.') || '(root)'}: ${detail.message}`;
    state.issues.push({
      severity: 'error',
      message: `<${tag}> nested ${candidate.type} "${candidate.id}": ${message}`,
      line,
    });
    return { id: candidate.id, type: 'invalid', data: { reason: message, tag: candidate.type } };
  }
  const emptiness = emptyPayloadMessage(candidate.type, candidate.data);
  if (emptiness) {
    state.issues.push({
      severity: 'warning',
      message: `<${tag}> nested ${candidate.type} "${candidate.id}": ${emptiness}`,
      line,
    });
  }
  return candidate;
}

function toNestedRef(block: PlanBlock): NestedBlockRef {
  return { id: block.id, type: block.type, data: block.data };
}

function invalidBlock(
  state: NormalizeState,
  tag: string,
  reason: string,
  source?: string,
): PlanBlock {
  return {
    type: 'invalid',
    id: nextId(state, 'invalid'),
    data: { reason, tag, ...(source !== undefined ? { source } : {}) },
  };
}

/** Claim the author-supplied id (unique across the document) or generate one. */
function claimId(
  state: NormalizeState,
  rawId: unknown,
  type: string,
  line: number | undefined,
): string {
  if (typeof rawId === 'string' && rawId !== '') {
    if (!state.usedIds.has(rawId)) {
      state.usedIds.add(rawId);
      return rawId;
    }
    state.issues.push({
      severity: 'warning',
      message: `duplicate block id "${rawId}" — suffixed to keep ids unique`,
      line,
    });
    return nextId(state, rawId);
  }
  return nextId(state, type);
}

function nextId(state: NormalizeState, prefix: string): string {
  let n = state.seq.get(prefix) ?? 0;
  let id: string;
  do {
    n += 1;
    id = `${prefix}-${n}`;
  } while (state.usedIds.has(id));
  state.seq.set(prefix, n);
  state.usedIds.add(id);
  return id;
}

function lineOf(
  node: { position?: { start: { line: number } } },
  state: NormalizeState,
): number | undefined {
  const line = node.position?.start.line;
  return line === undefined ? undefined : line + state.bodyStartLine - 1;
}

function sliceOf(el: MdxJsxFlowElement, state: NormalizeState): string | undefined {
  const start = el.position?.start.offset;
  const end = el.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  const text = state.body.slice(start, end);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Line of a micromark syntax error (VFileMessage carries `place`). */
function syntaxErrorLine(err: unknown, bodyStartLine: number): number | undefined {
  const place = (err as { place?: { line?: number } | { start?: { line?: number } } }).place;
  if (!place) return undefined;
  const line =
    typeof (place as { line?: number }).line === 'number'
      ? (place as { line: number }).line
      : (place as { start?: { line?: number } }).start?.line;
  return line === undefined ? undefined : line + bodyStartLine - 1;
}
