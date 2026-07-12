# Plan block vocabulary

Generated from the condash block registry (`condash mdx blocks`) — do not hand-edit.
Author against these tags; `condash mdx check <path>` validates the same schemas the
in-app viewer renders, so a green check is exactly what condash can display.

| type | MDX tag | key data fields | description |
| --- | --- | --- | --- |
| `rich-text` | `<RichText>` | markdown | Markdown prose. Ordinary top-level markdown imports as rich-text automatically; use the explicit tag only to preserve a stable block id. |
| `callout` | `<Callout>` | tone?, body | An emphasized note with a tone (info/decision/risk/warning/success) and a markdown body. |
| `table` | `<Table>` | columns, rows, density? | A simple grid with header columns and string rows for comparisons, parameters, or lists. |
| `checklist` | `<Checklist>` | items | A list of check items, each with an id, label, checked flag, and optional note. |
| `code` | `<Code>` | code, language?, filename?, caption?, maxLines? | A single syntax-highlighted code snippet. |
| `annotated-code` | `<AnnotatedCode>` | filename?, language?, code, annotations? | A line-numbered code walkthrough whose line ranges carry anchored explanatory notes. |
| `diff` | `<Diff>` | filename?, language?, before, after, mode?, annotations? | A before/after line diff for one file, split or unified, with added/removed highlighting and optional line-anchored annotations. |
| `file-tree` | `<FileTree>` | title?, entries | A file/change tree derived from slash-delimited paths, with per-file change badges (added/modified/removed/renamed), notes, and optional snippets. |
| `data-model` | `<DataModel>` | entities, relations? | A schema/ERD data model: entity cards with typed fields (pk/fk/nullable, change/was flags) and foreign-key relations. |
| `api-endpoint` | `<Endpoint>` | method, path, summary?, auth?, deprecated?, change?, params?, request?, responses? | An API endpoint reference: method pill + path, expanding to params, request body, and per-status response examples. Prose description goes in the MDX children. |
| `openapi-spec` | `<OpenApi>` | spec, title? | A whole-document API reference rendered from an OpenAPI 3 / Swagger 2 JSON spec. |
| `json-explorer` | `<Json>` | title?, json, collapsedDepth? | A collapsible JSON tree with type-colored values and expand/collapse. |
| `mermaid` | `<Mermaid>` | source, caption? | A Mermaid diagram for cases where textual sequence/flowchart grammar is clearer than a spatial layout. |
| `diagram` | `<Diagram>` | html?, css?, caption?, frame? | An inline architecture/data-flow diagram from semantic HTML + CSS. Use the .diagram-* primitives and --wf-* tokens; never fonts or hard-coded colors. |
| `wireframe` | `<WireframeBlock>` | surface, caption?, frame?, skeleton?, html?, css? | A wireframe of one screen: a `<Screen surface="…" html={…} />` child carrying a semantic HTML fragment, rendered in a desktop/browser/mobile/popover/panel surface. |
| `columns` | `<Columns>` | columns | A side-by-side container built from `<Column label="…">` children, each wrapping nested blocks. The standard Before/After comparison primitive. |
| `tabs` | `<TabsBlock>` | tabs, orientation? | A tab container; the whole `tabs` array (including nested child blocks in runtime JSON shape) is one prop — there is no nested Tab element. |
| `question-form` | `<QuestionForm>` | questions, submitLabel? | An open-questions form (single/multi/freeform, recommended options). condash renders it read-only; answers travel back through chat or note edits. |
| `custom-html` | `<HtmlBlock>` | html, css?, caption? | An author-supplied HTML (+ optional CSS) fragment, sanitized before rendering. A bounded escape hatch — prefer the native blocks. |

Deprecated (parse for old documents, never author):

- `<CodeTabs>` — deprecated: author a `tabs` block with `code` children instead.
- `<VisualQuestions>` — deprecated: author a `question-form` block instead.

## Authoring rules

- Ordinary top-level markdown imports as `rich-text` automatically; use `<RichText id="…">`
  only to pin a stable block id.
- Every capitalized block is self-closing (`<Diff … />`) or explicitly closed around children
  (`<Callout>…</Callout>`). A bare opening tag is unclosed JSX — the whole document fails.
- Every attribute is a STATIC literal: strings, numbers, booleans, object/array literals, or a
  template literal with no `${…}`. No imports, no expressions, no identifiers.
- Code-bearing blocks (`code`, `annotated-code`, `diff`) are whitespace-sensitive — encode
  multiline code as JSON string attributes, e.g. `code={"const x =\n  y"}`.
- `<Columns>` takes `<Column label="Before">…</Column>` CHILDREN wrapping nested blocks —
  never a `columns=` attribute array.
- `<TabsBlock>` takes the whole `tabs={[…]}` array as ONE prop, nested blocks in runtime JSON
  shape (`{ id, type, data }`) — there is no nested Tab element.
- `<WireframeBlock>` wraps one `<Screen surface="…" html={"…"} />` whose `html` is a
  semantic HTML fragment — bare elements, `.wf-*` helper classes, `--wf-*` color tokens,
  inline flex/grid layout. Never `<html>`/`<style>`/`<script>` tags, fonts, or hex colors.
- `<Diagram>` carries its markup as ```html and ```css fences in the children; use the
  `.diagram-*` primitives and `--wf-*` tokens.
- `<Endpoint>` prose description is the MDX children; each request/response `example` is one
  parseable JSON value in a string.
- Block headings are a `###` heading in the prose directly above the block, not a `title`
  prop.
