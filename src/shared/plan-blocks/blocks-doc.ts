import { BLOCK_SPECS } from './registry';

/**
 * Render the block-vocabulary reference document from the registry. This one
 * string is the catalog in three places: `condash mdx blocks` prints it, the
 * shipped `/visual` skill carries it as `blocks.md`, and a
 * drift test pins the shipped copy to this output — the registry is the single
 * source, so the lint (`mdx check`), the viewer, and the skills can never
 * disagree about the vocabulary.
 */
export function renderBlocksDoc(): string {
  const rows = BLOCK_SPECS.filter((spec) => !spec.deprecated).map(
    (spec) => `| \`${spec.type}\` | \`<${spec.tag}>\` | ${spec.fields} | ${spec.description} |`,
  );
  const deprecated = BLOCK_SPECS.filter((spec) => spec.deprecated).map(
    (spec) => `- \`<${spec.tag}>\` — deprecated: ${spec.deprecated}.`,
  );
  return `# Visual-note block vocabulary

Generated from the condash block registry (\`condash mdx blocks\`) — do not hand-edit.
Author against these tags; \`condash mdx check <path>\` validates the same schemas the
in-app viewer renders, so a green check is exactly what condash can display.

| type | MDX tag | key data fields | description |
| --- | --- | --- | --- |
${rows.join('\n')}

Deprecated (parse for old documents, never author):

${deprecated.join('\n')}

## Authoring rules

- Ordinary top-level markdown imports as \`rich-text\` automatically; use \`<RichText id="…">\`
  only to pin a stable block id.
- Every capitalized block is self-closing (\`<Diff … />\`) or explicitly closed around children
  (\`<Callout>…</Callout>\`). A bare opening tag is unclosed JSX — the whole document fails.
- Every attribute is a STATIC literal: strings, numbers, booleans, object/array literals, or a
  template literal with no \`\${…}\`. No imports, no expressions, no identifiers.
- Code-bearing blocks (\`code\`, \`annotated-code\`, \`diff\`) are whitespace-sensitive — encode
  multiline code as JSON string attributes, e.g. \`code={"const x =\\n  y"}\`.
- \`<Columns>\` takes \`<Column label="Before">…</Column>\` CHILDREN wrapping nested blocks —
  never a \`columns=\` attribute array.
- \`<TabsBlock>\` takes the whole \`tabs={[…]}\` array as ONE prop, nested blocks in runtime JSON
  shape (\`{ id, type, data }\`) — there is no nested Tab element.
- \`<WireframeBlock>\` wraps one \`<Screen surface="…" html={"…"} />\` whose \`html\` is a
  semantic HTML fragment — bare elements, \`.wf-*\` helper classes, \`--wf-*\` color tokens,
  inline flex/grid layout. Never \`<html>\`/\`<style>\`/\`<script>\` tags, fonts, or hex colors.
- \`<Diagram>\` carries its markup as \`\`\`html and \`\`\`css fences in the children; use the
  \`.diagram-*\` primitives and \`--wf-*\` tokens.
- \`<Endpoint>\` prose description is the MDX children; each request/response \`example\` is one
  parseable JSON value in a string.
- Block headings are a \`###\` heading in the prose directly above the block, not a \`title\`
  prop.
`;
}
