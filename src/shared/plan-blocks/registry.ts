/**
 * Block registry for plan/recap MDX documents (`plan.mdx` in a project item's
 * `notes/NN-<slug>/` folder). One row per block type: the runtime `type` id,
 * the MDX tag authors write, and the reference prose. The registry is the
 * single vocabulary shared by the parser (tag → type resolution), the viewer
 * (type → component dispatch), the `condash plans blocks` CLI verb, and the
 * shipped `visual-plan`/`visual-recap` skill reference — a drift test pins the
 * shipped reference to `renderBlocksDoc()` output.
 *
 * The dialect is deliberately data-only: capitalized tags with static-literal
 * props plus markdown prose. No imports, no expressions, no executable code —
 * that is what lets the viewer render agent-authored files without eval.
 */

export interface BlockSpec {
  /** Runtime type id (`diff`, `data-model`, …) — the discriminant on PlanBlock. */
  type: string;
  /** MDX tag authors write (`Diff`, `DataModel`, …). */
  tag: string;
  /** Key data fields, `?`-suffixed when optional — reference doc only. */
  fields: string;
  /** One-line reference description. */
  description: string;
  /** Children handling: how the element's MDX children map into `data`. */
  children?: 'markdown' | 'columns' | 'screen';
  /** Deprecated tags parse (mapped to their replacement where noted) but the
   *  reference doc tells authors not to write them. */
  deprecated?: string;
}

/** Every block type the parser accepts and the viewer renders. */
export const BLOCK_SPECS: readonly BlockSpec[] = [
  {
    type: 'rich-text',
    tag: 'RichText',
    fields: 'markdown',
    description:
      'Markdown prose. Ordinary top-level markdown imports as rich-text automatically; ' +
      'use the explicit tag only to preserve a stable block id.',
    children: 'markdown',
  },
  {
    type: 'callout',
    tag: 'Callout',
    fields: 'tone?, body',
    description:
      'An emphasized note with a tone (info/decision/risk/warning/success) and a markdown body.',
    children: 'markdown',
  },
  {
    type: 'table',
    tag: 'Table',
    fields: 'columns, rows, density?',
    description:
      'A simple grid with header columns and string rows for comparisons, parameters, or lists.',
  },
  {
    type: 'checklist',
    tag: 'Checklist',
    fields: 'items',
    description: 'A list of check items, each with an id, label, checked flag, and optional note.',
  },
  {
    type: 'code',
    tag: 'Code',
    fields: 'code, language?, filename?, caption?, maxLines?',
    description: 'A single syntax-highlighted code snippet.',
  },
  {
    type: 'annotated-code',
    tag: 'AnnotatedCode',
    fields: 'filename?, language?, code, annotations?',
    description:
      'A line-numbered code walkthrough whose line ranges carry anchored explanatory notes.',
  },
  {
    type: 'diff',
    tag: 'Diff',
    fields: 'filename?, language?, before, after, mode?, annotations?',
    description:
      'A before/after line diff for one file, split or unified, with added/removed ' +
      'highlighting and optional line-anchored annotations.',
  },
  {
    type: 'file-tree',
    tag: 'FileTree',
    fields: 'title?, entries',
    description:
      'A file/change tree derived from slash-delimited paths, with per-file change badges ' +
      '(added/modified/removed/renamed), notes, and optional snippets.',
  },
  {
    type: 'data-model',
    tag: 'DataModel',
    fields: 'entities, relations?',
    description:
      'A schema/ERD data model: entity cards with typed fields (pk/fk/nullable, ' +
      'change/was flags) and foreign-key relations.',
  },
  {
    type: 'api-endpoint',
    tag: 'Endpoint',
    fields: 'method, path, summary?, auth?, deprecated?, change?, params?, request?, responses?',
    description:
      'An API endpoint reference: method pill + path, expanding to params, request body, and ' +
      'per-status response examples. Prose description goes in the MDX children.',
    children: 'markdown',
  },
  {
    type: 'openapi-spec',
    tag: 'OpenApi',
    fields: 'spec, title?',
    description: 'A whole-document API reference rendered from an OpenAPI 3 / Swagger 2 JSON spec.',
  },
  {
    type: 'json-explorer',
    tag: 'Json',
    fields: 'title?, json, collapsedDepth?',
    description: 'A collapsible JSON tree with type-colored values and expand/collapse.',
  },
  {
    type: 'mermaid',
    tag: 'Mermaid',
    fields: 'source, caption?',
    description:
      'A Mermaid diagram for cases where textual sequence/flowchart grammar is clearer than a ' +
      'spatial layout.',
  },
  {
    type: 'diagram',
    tag: 'Diagram',
    fields: 'html?, css?, caption?, frame?',
    description:
      'An inline architecture/data-flow diagram from semantic HTML + CSS. Use the .diagram-* ' +
      'primitives and --wf-* tokens; never fonts or hard-coded colors.',
  },
  {
    type: 'wireframe',
    tag: 'WireframeBlock',
    fields: 'surface, caption?, frame?, skeleton?, html?, css?',
    description:
      'A wireframe of one screen: a `<Screen surface="…" html={…} />` child carrying a ' +
      'semantic HTML fragment, rendered in a desktop/browser/mobile/popover/panel surface.',
    children: 'screen',
  },
  {
    type: 'columns',
    tag: 'Columns',
    fields: 'columns',
    description:
      'A side-by-side container built from `<Column label="…">` children, each wrapping nested ' +
      'blocks. The standard Before/After comparison primitive.',
    children: 'columns',
  },
  {
    type: 'tabs',
    tag: 'TabsBlock',
    fields: 'tabs, orientation?',
    description:
      'A tab container; the whole `tabs` array (including nested child blocks in runtime JSON ' +
      'shape) is one prop — there is no nested Tab element.',
  },
  {
    type: 'question-form',
    tag: 'QuestionForm',
    fields: 'questions, submitLabel?',
    description:
      'An open-questions form (single/multi/freeform, recommended options). condash renders it ' +
      'read-only; answers travel back through chat or note edits.',
  },
  {
    type: 'custom-html',
    tag: 'HtmlBlock',
    fields: 'html, css?, caption?',
    description:
      'An author-supplied HTML (+ optional CSS) fragment, sanitized before rendering. A bounded ' +
      'escape hatch — prefer the native blocks.',
  },
  {
    type: 'code-tabs',
    tag: 'CodeTabs',
    fields: 'tabs',
    description: 'A vertical file rail of code snippets.',
    deprecated: 'author a `tabs` block with `code` children instead',
  },
  {
    type: 'visual-questions',
    tag: 'VisualQuestions',
    fields: 'questions, submitLabel?',
    description: 'Legacy visual-intake questions.',
    deprecated: 'author a `question-form` block instead',
  },
] as const;

const SPEC_BY_TAG = new Map(BLOCK_SPECS.map((spec) => [spec.tag, spec]));

/** Resolve an MDX tag (`Diff`) to its block spec, or undefined for an unknown tag. */
export function specForTag(tag: string): BlockSpec | undefined {
  return SPEC_BY_TAG.get(tag);
}
