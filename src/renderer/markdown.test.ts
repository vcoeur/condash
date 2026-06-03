import { describe, expect, it } from 'vitest';
import { highlightCode } from './markdown';

describe('highlightCode', () => {
  it('wraps output in a hljs pre/code block', async () => {
    const html = await highlightCode('body { color: red; }', 'styles.css');
    expect(html.startsWith('<pre class="hljs"><code>')).toBe(true);
    expect(html.endsWith('</code></pre>')).toBe(true);
  });

  it('emits highlight token classes for a known language', async () => {
    const html = await highlightCode('const x = 1;', 'a.ts');
    expect(html).toContain('hljs-');
  });

  it('escapes HTML so source content cannot inject markup', async () => {
    const html = await highlightCode('<script>alert(1)</script>', 'note.txt');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('falls back to escaped plain text for an unknown extension', async () => {
    const html = await highlightCode('a < b && c > d', 'data.unknownext');
    expect(html).toContain('&lt;');
    expect(html).toContain('&amp;&amp;');
    expect(html).toContain('&gt;');
  });

  it('degrades to plain text past the size cap without throwing', async () => {
    const big = 'x'.repeat(200_001);
    const html = await highlightCode(big, 'huge.js');
    expect(html.startsWith('<pre class="hljs"><code>')).toBe(true);
    expect(html).not.toContain('hljs-');
  });
});
