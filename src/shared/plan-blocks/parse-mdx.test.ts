import { describe, expect, it } from 'vitest';
import { parsePlanMdx } from './parse-mdx';
import { evaluateLiteral, NonLiteralError } from './literal-eval';
import { renderBlocksDoc } from './blocks-doc';
import type { ColumnsData, DiffData, InvalidBlockData, WireframeData } from './schemas';

describe('parsePlanMdx', () => {
  it('parses frontmatter, prose, and a typed block', () => {
    const doc = parsePlanMdx(
      [
        '---',
        'title: Test plan',
        'kind: plan',
        '---',
        '',
        '## Summary',
        '',
        'Some *prose* here.',
        '',
        '<Diff id="d1" filename="a.ts" before={"a\\n"} after={"b\\n"} mode="split" />',
        '',
        'Trailing prose.',
      ].join('\n'),
    );
    expect(doc.frontmatter.title).toBe('Test plan');
    expect(doc.frontmatter.kind).toBe('plan');
    expect(doc.issues).toEqual([]);
    expect(doc.blocks.map((b) => b.type)).toEqual(['rich-text', 'diff', 'rich-text']);
    expect(doc.blocks[0].data.markdown).toBe('## Summary\n\nSome *prose* here.');
    const diff = doc.blocks[1].data as unknown as DiffData;
    expect(diff.before).toBe('a\n');
    expect(diff.mode).toBe('split');
    expect(doc.blocks[1].id).toBe('d1');
  });

  it('normalizes a deprecated `recap` kind to `review` with a warning', () => {
    const doc = parsePlanMdx(['---', 'kind: recap', '---', '', 'x', ''].join('\n'));
    expect(doc.frontmatter.kind).toBe('review');
    expect(doc.issues.some((i) => i.severity === 'warning' && i.message.includes('recap'))).toBe(
      true,
    );
  });

  it('folds markdown children into callout body and endpoint description', () => {
    const doc = parsePlanMdx(
      [
        '<Callout id="c1" tone="risk">',
        '',
        'Watch **this**.',
        '',
        '</Callout>',
        '',
        '<Endpoint id="e1" method="GET" path="/v1/x">',
        '',
        'Returns the thing.',
        '',
        '</Endpoint>',
      ].join('\n'),
    );
    expect(doc.issues).toEqual([]);
    expect(doc.blocks[0].data.body).toBe('Watch **this**.');
    expect(doc.blocks[1].data.description).toBe('Returns the thing.');
  });

  it('normalizes Columns children with nested blocks', () => {
    const doc = parsePlanMdx(
      [
        '<Columns id="cols">',
        '<Column id="before" label="Before">',
        '',
        'Old shape.',
        '',
        '</Column>',
        '<Column label="After">',
        '',
        '<WireframeBlock id="wf">',
        '  <Screen surface="panel" html={"<div>hi</div>"} caption="After state" />',
        '</WireframeBlock>',
        '',
        '</Column>',
        '</Columns>',
      ].join('\n'),
    );
    expect(doc.issues).toEqual([]);
    const cols = doc.blocks[0].data as unknown as ColumnsData;
    expect(cols.columns).toHaveLength(2);
    expect(cols.columns[0].label).toBe('Before');
    expect(cols.columns[0].blocks[0].type).toBe('rich-text');
    const wf = cols.columns[1].blocks[0];
    expect(wf.type).toBe('wireframe');
    expect((wf.data as unknown as WireframeData).surface).toBe('panel');
    expect((wf.data as unknown as WireframeData).html).toBe('<div>hi</div>');
  });

  it('preserves legacy kit-tree Screen children with a warning', () => {
    const doc = parsePlanMdx(
      [
        '<WireframeBlock id="wf">',
        '  <Screen surface="desktop" caption="Legacy">',
        '    <Row>',
        '      <Title text="Editor" />',
        '    </Row>',
        '  </Screen>',
        '</WireframeBlock>',
      ].join('\n'),
    );
    const wf = doc.blocks[0].data as unknown as WireframeData;
    expect(wf.kit).toHaveLength(1);
    expect(wf.kit![0].el).toBe('Row');
    expect(wf.kit![0].children[0].props.text).toBe('Editor');
    expect(doc.issues.some((i) => i.message.includes('kit-tree'))).toBe(true);
  });

  it('folds Diagram html/css fences from children', () => {
    const doc = parsePlanMdx(
      [
        '<Diagram id="dg" caption="Flow">',
        '',
        '```html',
        '<div class="diagram-panel">x</div>',
        '```',
        '',
        '```css',
        '.diagram-panel { display: flex; }',
        '```',
        '',
        '</Diagram>',
      ].join('\n'),
    );
    expect(doc.issues).toEqual([]);
    expect(doc.blocks[0].data.html).toContain('diagram-panel');
    expect(doc.blocks[0].data.css).toContain('display: flex');
  });

  it('folds Screen html/css fences from children like Diagram', () => {
    const doc = parsePlanMdx(
      [
        '<WireframeBlock id="wf">',
        '  <Screen surface="panel" caption="Menu">',
        '',
        '  ```html',
        '  <div class="wf-card">Save</div>',
        '  ```',
        '',
        '  ```css',
        '  .wf-card { padding: 8px; }',
        '  ```',
        '',
        '  </Screen>',
        '</WireframeBlock>',
      ].join('\n'),
    );
    expect(doc.issues).toEqual([]);
    const wf = doc.blocks[0].data as unknown as WireframeData;
    expect(wf.surface).toBe('panel');
    expect(wf.html).toContain('wf-card');
    expect(wf.css).toContain('padding: 8px');
  });

  it('warns on a visually-empty payload but keeps the block renderable elsewhere', () => {
    const doc = parsePlanMdx(
      ['<Diagram id="d" caption="empty" />', '', '<Code id="c" code={"const x = 1;\\n"} />'].join(
        '\n',
      ),
    );
    expect(doc.blocks.map((b) => b.type)).toEqual(['diagram', 'code']);
    const warning = doc.issues.find((i) => i.severity === 'warning');
    expect(warning?.message).toContain('no html payload');
    // The block with real content draws no warning.
    expect(doc.issues.filter((i) => i.severity === 'warning')).toHaveLength(1);
  });

  it('salvages an invalid nested tab block and keeps the rest', () => {
    const doc = parsePlanMdx(
      [
        '<TabsBlock',
        '  id="t"',
        '  tabs={[',
        '    { id: "a", label: "ok", blocks: [{ id: "n1", type: "rich-text", data: { markdown: "hi" } }] },',
        '    { id: "b", label: "bad", blocks: [{ id: "n2", type: "nope", data: {} }] },',
        '  ]}',
        '/>',
      ].join('\n'),
    );
    const tabs = doc.blocks[0].data.tabs as Array<{ blocks: Array<{ type: string }> }>;
    expect(tabs[0].blocks[0].type).toBe('rich-text');
    expect(tabs[1].blocks[0].type).toBe('invalid');
    expect(doc.issues.some((i) => i.severity === 'error' && i.message.includes('nope'))).toBe(true);
  });

  it('turns an unknown tag into an invalid placeholder and keeps parsing', () => {
    const doc = parsePlanMdx('<Bogus id="x" />\n\nStill here.\n');
    expect(doc.blocks[0].type).toBe('invalid');
    expect((doc.blocks[0].data as unknown as InvalidBlockData).tag).toBe('Bogus');
    expect(doc.blocks[1].type).toBe('rich-text');
    expect(doc.issues[0].severity).toBe('error');
  });

  it('rejects imports, expressions, and non-literal attributes without aborting', () => {
    const doc = parsePlanMdx(
      ['import x from "y"', '', '{1 + 1}', '', '<Code id="c" code={someVar} />'].join('\n'),
    );
    expect(doc.issues.map((i) => i.severity)).toEqual(['error', 'warning', 'error']);
    expect(doc.blocks.map((b) => b.type)).toEqual(['invalid']);
  });

  it('reports schema failures with the block salvaged as invalid', () => {
    const doc = parsePlanMdx('<Table id="t" columns="not-an-array" rows={[]} />\n');
    expect(doc.blocks[0].type).toBe('invalid');
    expect(doc.issues[0].message).toContain('columns');
  });

  it('suffixes duplicate ids with a warning', () => {
    const doc = parsePlanMdx('<Code id="x" code={"a"} />\n\n<Code id="x" code={"b"} />\n');
    expect(doc.blocks[0].id).toBe('x');
    expect(doc.blocks[1].id).toBe('x-1');
    expect(doc.issues[0].message).toContain('duplicate block id');
  });

  it('returns one error and zero blocks on a document-level syntax error', () => {
    const doc = parsePlanMdx('# ok\n\n<RichText id="r">\n\nunclosed\n');
    expect(doc.blocks).toEqual([]);
    expect(doc.issues).toHaveLength(1);
    expect(doc.issues[0].severity).toBe('error');
  });

  it('treats lowercase jsx as prose', () => {
    const doc = parsePlanMdx('before\n\n<div>raw</div>\n\nafter\n');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].type).toBe('rich-text');
    expect(doc.blocks[0].data.markdown).toContain('<div>raw</div>');
  });
});

describe('evaluateLiteral', () => {
  const parseExpr = (mdx: string): unknown => {
    const doc = parsePlanMdx(`<Json id="j" json=${mdx} />`);
    if (doc.blocks[0].type === 'invalid') throw new Error(String(doc.blocks[0].data.reason));
    return doc.blocks[0].data.json;
  };

  it('evaluates strings, template literals, and nested structures', () => {
    expect(parseExpr('{"a\\nb"}')).toBe('a\nb');
    expect(parseExpr('{`line`}')).toBe('line');
  });

  it('rejects identifiers, calls, and interpolation', () => {
    expect(() => parseExpr('{foo}')).toThrow(/Identifier/);
    expect(() => parseExpr('{fn()}')).toThrow(/non-literal/);
    expect(() => parseExpr('{`a${1}`}')).toThrow(/TemplateLiteral/);
  });

  it('supports negative numbers and boolean/null literals directly', () => {
    expect(
      evaluateLiteral({
        type: 'UnaryExpression',
        operator: '-',
        argument: { type: 'Literal', value: 4 },
      }),
    ).toBe(-4);
    expect(() => evaluateLiteral({ type: 'CallExpression' })).toThrow(NonLiteralError);
  });
});

describe('renderBlocksDoc', () => {
  it('lists every non-deprecated tag and flags deprecated ones', () => {
    const doc = renderBlocksDoc();
    expect(doc).toContain('`<Diff>`');
    expect(doc).toContain('`<WireframeBlock>`');
    expect(doc).toContain('`<CodeTabs>` — deprecated');
    expect(doc).not.toMatch(/\| `code-tabs` \|/);
  });
});
