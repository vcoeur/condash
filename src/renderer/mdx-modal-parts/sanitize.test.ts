import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attributeReachesOutside,
  resolveWfTokens,
  standaloneCss,
  standaloneSvg,
  SVG_CARD_TOKENS,
} from './sanitize';

/** The `--wf-*` literals `.plan-svg-card` declares in plan-blocks.css. */
function cardTokensFromCss(): Record<string, string> {
  const css = readFileSync(resolve(__dirname, 'plan-blocks.css'), 'utf8');
  const start = css.indexOf('.plan-svg-card {');
  expect(start, '.plan-svg-card rule present').toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/(--wf-[a-z-]+)\s*:\s*([^;]+);/g))
    out[match[1]] = match[2].trim();
  return out;
}

describe('SVG_CARD_TOKENS', () => {
  it('matches the literals .plan-svg-card pins in plan-blocks.css', () => {
    expect(cardTokensFromCss()).toEqual(SVG_CARD_TOKENS);
  });
});

describe('resolveWfTokens', () => {
  it('replaces every var(--wf-*) reference, with or without a fallback', () => {
    const input = 'fill="var(--wf-accent)" stroke="var( --wf-line , red )" x="var(--other)"';
    expect(resolveWfTokens(input)).toBe('fill="#672167" stroke="#ddd2da" x="var(--other)"');
  });

  it('handles fallbacks that themselves carry parentheses', () => {
    expect(
      resolveWfTokens('fill="var(--wf-accent, rgb(0 0 0))" s="var(--wf-line, var(--x))"'),
    ).toBe('fill="#672167" s="#ddd2da"');
    expect(resolveWfTokens('a="var(--other, rgb(1,2,3))" b="var(--wf-ok)"')).toBe(
      'a="var(--other, rgb(1,2,3))" b="#2e7d32"',
    );
  });
});

describe('standaloneSvg', () => {
  it('adds xmlns, embeds the css as a style child, resolves tokens and XML-safes nbsp', () => {
    const out = standaloneSvg(
      '<svg viewBox="0 0 1 1"><text class="t">a&nbsp;b</text></svg>',
      '.t { fill: var(--wf-ink); }',
    );
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">')).toBe(true);
    expect(out).toContain('<style>.t { fill: #1a1418; }</style>');
    expect(out).toContain('a&#160;b');
    expect(out).not.toContain('var(--wf');
  });

  it('keeps an existing xmlns and scrubs @import / external url() out of the css', () => {
    const out = standaloneSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
      '@import url(x.css); .t { background: url(http://evil/x.png); }',
    );
    expect(out.match(/xmlns=/g)).toHaveLength(1);
    expect(out).not.toContain('@import');
    expect(out).not.toMatch(/[^-]url\s*\(/);
  });

  it('declares xmlns:xlink when xlink attributes occur', () => {
    const out = standaloneSvg('<svg viewBox="0 0 1 1"><use xlink:href="#g"/></svg>');
    expect(out).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(out.match(/xmlns:xlink=/g)).toHaveLength(1);
    expect(
      standaloneSvg('<svg xmlns:xlink="x" viewBox="0 0 1 1"><a xlink:href="#g"/></svg>').match(
        /xmlns:xlink=/g,
      ),
    ).toHaveLength(1);
  });

  it('embeds no style element when there is no css', () => {
    expect(standaloneSvg('<svg viewBox="0 0 1 1"></svg>')).not.toContain('<style>');
  });

  it('a css fence cannot break out of the style element', () => {
    const out = standaloneSvg(
      '<svg viewBox="0 0 1 1"></svg>',
      '.t{fill:red} </style><script>alert(1)</script><style>',
    );
    expect(out).not.toContain('<script');
    expect(out.match(/<style>/g)).toHaveLength(1);
    expect(out).toContain('\\3c /style>');
  });

  it('honours a quoted > in a root attribute and a leading comment', () => {
    const out = standaloneSvg(
      '<!-- exported --><svg viewBox="0 0 10 10" aria-label="A -> B"><rect/></svg>',
      '.t{fill:red}',
    );
    expect(
      out.startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-label="A -> B">',
      ),
    ).toBe(true);
    expect(out).toContain('aria-label="A -> B">\n<style>');
    expect(out.match(/xmlns=/g)).toHaveLength(1);
  });
});

describe('standaloneCss', () => {
  it('keeps child combinators and fragment urls, neutralises escapes and external urls', () => {
    const css =
      '.box > text { marker-end: url(#arrow); fill: u\\72l(http://x) } .a { background: url( "https://e/x.png" ) } b { c: "&" }';
    const out = standaloneCss(css);
    expect(out).toContain('.box > text');
    expect(out).toContain('url(#arrow)');
    expect(out).toContain('u\\\\72l(http://x)');
    expect(out).toContain('url-removed( "https://e/x.png" )');
    expect(out).toContain('"\\26 "');
    expect(out).not.toContain('<');
  });

  it('keeps quoted and space-led fragment urls', () => {
    const out = standaloneCss('.e { marker-end: url(\'#a\'); fill: url( "#g" ); mask: url( #m) }');
    expect(out).toContain("url('#a')");
    expect(out).toContain('url( "#g" )');
    expect(out).toContain('url( #m)');
    expect(out).not.toContain('url-removed');
  });
});

describe('attributeReachesOutside', () => {
  it('passes fragment urls in any quoting and plain values', () => {
    for (const value of [
      'url(#g)',
      "url('#g')",
      'url( "#g" )',
      'url( #m)',
      'M0 0L10 10',
      'var(--wf-ink)',
      '0 0 10 10',
    ]) {
      expect(attributeReachesOutside(value), value).toBe(false);
    }
  });

  it('flags non-fragment urls and any backslash', () => {
    for (const value of [
      'url(https://evil/x.svg#a)',
      "url('https://e')",
      'fill:url(https://e)',
      'url(x.png)',
      'cursor:u\\72l(https://x)',
      'a\\b',
    ]) {
      expect(attributeReachesOutside(value), value).toBe(true);
    }
  });
});
