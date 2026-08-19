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

  it('accepts the known postures and any off-list kind without a warning', () => {
    for (const kind of ['design', 'plan', 'review', 'note', 'proposal']) {
      const doc = parsePlanMdx(['---', `kind: ${kind}`, '---', '', 'x', ''].join('\n'));
      expect(doc.frontmatter.kind).toBe(kind);
      expect(doc.issues.some((i) => i.message.includes('kind'))).toBe(false);
    }
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

  it('folds Svg svg/css fences from children and accepts a well-formed diagram', () => {
    const doc = parsePlanMdx(
      [
        '<Svg id="sv" caption="Flow" alt="A then B">',
        '',
        '```svg',
        '<svg viewBox="0 0 10 10" width="10" height="10"><rect width="5" height="5" class="b"/></svg>',
        '```',
        '',
        '```css',
        '.b { fill: var(--wf-accent); }',
        '```',
        '',
        '</Svg>',
      ].join('\n'),
    );
    expect(doc.issues).toEqual([]);
    expect(doc.blocks[0].type).toBe('svg');
    expect(doc.blocks[0].id).toBe('sv');
    expect(doc.blocks[0].data.svg).toContain('<rect');
    expect(doc.blocks[0].data.css).toContain('--wf-accent');
    expect(doc.blocks[0].data.alt).toBe('A then B');
  });

  it('Svg: a missing fence or a non-svg root is an error and the block is salvaged', () => {
    const doc = parsePlanMdx(
      [
        '<Svg alt="x" />',
        '',
        '<Svg alt="y">',
        '',
        '```svg',
        '<div>not svg</div>',
        '```',
        '',
        '</Svg>',
      ].join('\n'),
    );
    expect(doc.blocks.map((b) => b.type)).toEqual(['invalid', 'invalid']);
    const messages = doc.issues.map((i) => `${i.severity}:${i.message}`);
    expect(messages[0]).toContain('error:<Svg>: no svg payload');
    expect(messages[1]).toContain('error:<Svg>: the ```svg fence must hold an <svg> root element');
  });

  it('Svg: warns on a missing viewBox, a missing alt, and elements the viewer strips', () => {
    const doc = parsePlanMdx(
      [
        '<Svg>',
        '',
        '```svg',
        '<svg width="10" height="10"><style>.a{}</style><foreignObject/><script>1</script><use href="#x"/><animate/><set/></svg>',
        '```',
        '',
        '</Svg>',
      ].join('\n'),
    );
    expect(doc.blocks[0].type).toBe('svg');
    const warnings = doc.issues.filter((i) => i.severity === 'warning').map((i) => i.message);
    expect(warnings.some((w) => w.includes('no viewBox'))).toBe(true);
    expect(warnings.some((w) => w.includes('no alt'))).toBe(true);
    for (const name of ['<style>', '<script>', '<foreignObject>', '<use>', '<animate>', '<set>']) {
      expect(
        warnings.some((w) => w.includes(name)),
        name,
      ).toBe(true);
    }
    // A clean diagram with viewBox + alt raises none of them.
    const clean = parsePlanMdx(
      ['<Svg alt="ok">', '', '```svg', '<svg viewBox="0 0 1 1"></svg>', '```', '', '</Svg>'].join(
        '\n',
      ),
    );
    expect(clean.issues).toEqual([]);
  });

  it('Svg: an XML prolog, DOCTYPE or comment before the root is fine, and a quoted > is honoured', () => {
    const doc = parsePlanMdx(
      [
        '<Svg alt="x">',
        '',
        '```svg',
        '<?xml version="1.0"?>',
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
        '<!-- from a tool, <style> mentioned here is not an element -->',
        '<svg aria-label="A > B" viewBox="0 0 1 1"></svg>',
        '```',
        '',
        '</Svg>',
      ].join('\n'),
    );
    expect(doc.blocks[0].type).toBe('svg');
    expect(doc.issues).toEqual([]);
  });

  it('Svg: a DOCTYPE internal subset is an error, as the viewer would show its tail as text', () => {
    const doc = parsePlanMdx(
      [
        '<Svg alt="x">',
        '',
        '```svg',
        '<!DOCTYPE svg [ <!ENTITY ns "x"> ]>',
        '<svg viewBox="0 0 1 1"></svg>',
        '```',
        '',
        '</Svg>',
      ].join('\n'),
    );
    expect(doc.blocks[0].type).toBe('invalid');
    expect(doc.issues[0].message).toContain('must hold an <svg> root');
  });

  it('Svg: the animation family is warned on with its real casing, and nested svg blocks are checked too', () => {
    const doc = parsePlanMdx(
      [
        '<Svg alt="x">',
        '',
        '```svg',
        '<svg viewBox="0 0 1 1"><animateTransform attributeName="transform"/></svg>',
        '```',
        '',
        '</Svg>',
        '',
        '<TabsBlock tabs={[{ id: "t", label: "T", blocks: [{ id: "n", type: "svg", data: { svg: "<div>no</div>" } }] }]} />',
      ].join('\n'),
    );
    const messages = doc.issues.map((i) => `${i.severity}:${i.message}`);
    expect(messages.some((m) => m.startsWith('warning:') && m.includes('<animateTransform>'))).toBe(
      true,
    );
    expect(messages.some((m) => m.startsWith('error:') && m.includes('nested svg "n"'))).toBe(true);
    const tabs = doc.blocks[1].data as { tabs: { blocks: { type: string }[] }[] };
    expect(tabs.tabs[0].blocks[0].type).toBe('invalid');
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
