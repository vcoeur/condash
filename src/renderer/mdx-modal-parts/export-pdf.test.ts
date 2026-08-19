import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cssVarsConsumed, cssVarsDefined, extractRootTokens } from './export-pdf';

const read = (rel: string): string => readFileSync(resolve(__dirname, rel), 'utf8');

describe('extractRootTokens', () => {
  it('lifts the first top-level :root block and nothing after it', () => {
    const css = 'a{}\n:root {\n  --x: 1;\n  --y: var(--x);\n}\n[data-theme="dark"] { --x: 2; }';
    expect(extractRootTokens(css)).toBe(':root {\n  --x: 1;\n  --y: var(--x);\n}');
  });

  it('finds the block in minified CSS, after @font-face blocks, skipping a nested :root', () => {
    const css =
      '@font-face{font-family:X;src:url(x.woff2)}@media (prefers-color-scheme:dark){:root:not([data-theme]){--x:9}}:root{--x:1;--y:var(--x)}[data-theme=dark]{--x:2}';
    expect(extractRootTokens(css)).toBe(':root{--x:1;--y:var(--x)}');
  });

  it('returns an empty string when there is no :root block', () => {
    expect(extractRootTokens('a { color: red; }')).toBe('');
  });

  it('from styles.css, carries the light palette and leaves the dark arms behind', () => {
    const tokens = extractRootTokens(read('../styles.css'));
    expect(tokens).not.toBe('');
    const defined = cssVarsDefined(tokens);
    for (const name of ['--text', '--bg-elevated', '--accent', '--border-strong', '--font-mono']) {
      expect(defined.has(name), name).toBe(true);
    }
    expect(tokens).not.toContain('prefers-color-scheme');
    expect(tokens).not.toContain('[data-theme');
  });
});

describe('the export stylesheet resolves every token plan-blocks.css consumes', () => {
  // Drift guard: plan-blocks.css is themed entirely through app tokens, and
  // the print document has no app stylesheet — only the lifted :root block.
  // A token used by a block but defined outside that block (or not at all)
  // would print unstyled, silently. `--wf-*` tokens are defined by
  // plan-blocks.css itself on `.plan-doc`.
  it('every var(--x) in plan-blocks.css is a --wf-* token or a :root light token', () => {
    const root = cssVarsDefined(extractRootTokens(read('../styles.css')));
    const blockSheet = read('plan-blocks.css');
    const local = cssVarsDefined(blockSheet);
    const missing = [...cssVarsConsumed(blockSheet)].filter(
      (name) => !name.startsWith('--wf-') && !root.has(name) && !local.has(name),
    );
    expect(missing).toEqual([]);
  });

  it('every var(--x) in mdx-export.css is covered the same way', () => {
    const root = cssVarsDefined(extractRootTokens(read('../styles.css')));
    const missing = [...cssVarsConsumed(read('mdx-export.css'))].filter(
      (name) => !name.startsWith('--wf-') && !root.has(name),
    );
    expect(missing).toEqual([]);
  });
});
