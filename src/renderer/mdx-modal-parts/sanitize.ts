/**
 * Sanitization for author-supplied HTML in plan blocks (wireframe screens,
 * diagrams, custom-html). Plans are agent-authored files inside the
 * conception, so the fragment is untrusted: DOMPurify strips scripts, event
 * handlers, and dangerous tags; a hook downgrades `position:fixed` so a
 * fragment can't overlay app chrome outside its block. External resource
 * loads are already dead at the CSP layer (`img-src 'self' data:
 * condash-file:`, no remote `connect-src`).
 *
 * DOMPurify is lazy-loaded with the first sanitize call — it rides the
 * mdx-parts chunk out of the boot path either way, but the import cost is
 * only paid when a document actually carries an HTML-bearing block.
 */

import { SVG_STRIPPED_ELEMENTS, svgRootTag } from '@shared/plan-blocks/svg-markup';

type DomPurifyModule = typeof import('dompurify').default;

let purifyPromise: Promise<DomPurifyModule> | null = null;

async function getPurify(): Promise<DomPurifyModule> {
  if (!purifyPromise) {
    purifyPromise = import('dompurify').then(({ default: purify }) => {
      purify.addHook('afterSanitizeAttributes', (node) => {
        if (!(node instanceof Element)) return;
        const style = node.getAttribute('style');
        if (style && /position\s*:\s*fixed/i.test(style)) {
          node.setAttribute('style', style.replace(/position\s*:\s*fixed/gi, 'position:absolute'));
        }
        // Links inside a wireframe/diagram are mock affordances, never
        // navigation. Neutralise the href; the modal's click router treats
        // `#` as an in-document anchor no-op. `localName`, not `tagName`: an
        // `<a>` inside `<svg>` is foreign content and keeps its lowercase name,
        // so an uppercase comparison would let SVG anchors through.
        if (node.localName === 'a') {
          node.setAttribute('href', '#');
          node.removeAttribute('xlink:href');
        }
      });
      return purify;
    });
  }
  return purifyPromise;
}

const FORBID_TAGS = [
  'style',
  'link',
  'meta',
  'base',
  'form',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
];

/** Sanitize an author-supplied HTML fragment for inline rendering. */
export async function sanitizeFragment(html: string): Promise<string> {
  const purify = await getPurify();
  return purify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS,
  });
}

let svgPurifyPromise: Promise<DomPurifyModule> | null = null;

/** A reference an svg block may keep: same-document (`#id`) or an inline
 *  raster. Anything else — http(s), file, a bare path — leaves the viewer
 *  (CSP kills it there) but would load from the standalone file. */
const SVG_LOCAL_REF = /^(?:#|data:image\/)/i;

/**
 * Does an attribute value reach outside the document? One rule for every
 * attribute, whatever its name — `fill`, `filter`, `mask`, `clip-path`,
 * `marker-*`, `style`, anything DOMPurify's profile admits can carry a
 * `url()` paint server or filter: a `url(` whose argument (quotes and
 * whitespace allowed) is not a `#fragment`, or any backslash, which is how a
 * CSS ident escape spells `u\72l(` without the letters. Attributes never
 * need a backslash in SVG, so dropping on sight costs nothing legitimate.
 */
export function attributeReachesOutside(value: string): boolean {
  if (value.includes('\\')) return true;
  for (const match of value.matchAll(/url\(\s*(['"]?)\s*([^'")\s]*)/gi)) {
    if (!match[2].startsWith('#')) return true;
  }
  return false;
}

/**
 * The svg block's own DOMPurify instance (a second `createDOMPurify`, so its
 * hooks never touch the wireframe/diagram HTML path). Beyond the SVG-only
 * profile it strips every external reference at sanitize time — `href` /
 * `xlink:href` not pointing at a fragment or an inline raster, and any
 * attribute at all whose value reaches outside (`attributeReachesOutside`) —
 * so the markup the card draws is already the markup the standalone file can
 * hold: no second policy for the download. `position: fixed` is downgraded
 * and anchors neutralised as in the HTML path.
 */
async function getSvgPurify(): Promise<DomPurifyModule> {
  if (!svgPurifyPromise) {
    svgPurifyPromise = import('dompurify').then(({ default: purify }) => {
      const instance = purify(window) as DomPurifyModule;
      instance.addHook('afterSanitizeAttributes', (node) => {
        if (!(node instanceof Element)) return;
        for (const attr of [...node.attributes]) {
          const isRef = attr.name === 'href' || attr.name === 'xlink:href';
          if (
            isRef ? !SVG_LOCAL_REF.test(attr.value.trim()) : attributeReachesOutside(attr.value)
          ) {
            node.removeAttribute(attr.name);
          }
        }
        const style = node.getAttribute('style');
        if (style !== null && /position\s*:\s*fixed/i.test(style)) {
          node.setAttribute('style', style.replace(/position\s*:\s*fixed/gi, 'position:absolute'));
        }
        if (node.localName === 'a') {
          node.setAttribute('href', '#');
          node.removeAttribute('xlink:href');
        }
      });
      return instance;
    });
  }
  return svgPurifyPromise;
}

/**
 * Sanitize an svg block's markup for inline rendering. SVG profiles only — no
 * HTML vocabulary can ride in through `<foreignObject>` (forbidden outright,
 * on top of DOMPurify already dropping it), and the animation family joins
 * `animate` / `set` (which DOMPurify drops) so nothing can retarget an
 * attribute after the fact. `<style>` stays forbidden as in the HTML path: an
 * inline SVG's stylesheet is document-scoped, so class rules go through the
 * block's ```css fence, which the viewer prefixes per block. External
 * references are dropped by the instance's hook (`getSvgPurify`).
 */
export async function sanitizeSvg(markup: string): Promise<string> {
  const purify = await getSvgPurify();
  return purify.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // One list with `condash mdx check` (SVG_STRIPPED_ELEMENTS): the check
    // warns on exactly what is dropped here. DOMPurify keys are lowercase.
    FORBID_TAGS: [...FORBID_TAGS, ...SVG_STRIPPED_ELEMENTS.map((name) => name.toLowerCase())],
  });
}

/**
 * The light values the svg card pins its `--wf-*` tokens to, in both themes —
 * the same literals `.plan-svg-card` carries in `plan-blocks.css` (a test keeps
 * the two in step). Used to resolve tokens out of a diagram that leaves the
 * viewer: a standalone `.svg` file has no stylesheet to resolve `var()` against.
 */
export const SVG_CARD_TOKENS: Readonly<Record<string, string>> = {
  '--wf-ink': '#1a1418',
  '--wf-muted': '#665c64',
  '--wf-line': '#ddd2da',
  '--wf-paper': '#ffffff',
  '--wf-card': '#f5f0f3',
  '--wf-accent': '#672167',
  '--wf-accent-fg': '#ffffff',
  '--wf-accent-soft': '#f6e4ef',
  '--wf-warn': '#b03020',
  '--wf-ok': '#2e7d32',
  '--wf-radius': '6px',
};

/** Replace every `var(--wf-*)` — with or without a fallback, the fallback
 *  itself possibly holding parentheses (`rgb()`, a nested `var()`) — by its
 *  card value. A balanced-paren scan, not a regex, so the closing `)` found is
 *  the call's own. */
export function resolveWfTokens(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('var(', i);
    if (at < 0) break;
    let depth = 0;
    let close = -1;
    for (let j = at + 3; j < text.length; j += 1) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) break;
    const inner = text.slice(at + 4, close);
    const name = inner.match(/^\s*(--wf-[a-z-]+)\s*(?:,|$)/)?.[1];
    const value = name ? SVG_CARD_TOKENS[name] : undefined;
    out += text.slice(i, at) + (value ?? text.slice(at, close + 1));
    i = close + 1;
  }
  return out + text.slice(i);
}

/**
 * The block's css fence as it goes into the standalone file's `<style>`.
 * The fence is author text landing in an element the XML parser reads raw,
 * so three things are made impossible and nothing else is touched:
 * - markup: `<` and `&` become the CSS escapes `\3c ` / `\26 `, which every
 *   CSS engine reads back as the character — `</style>` cannot close the
 *   element; `>` needs no escaping in XML text and stays a child combinator;
 * - escape tricks: every backslash is doubled first, so an author escape
 *   such as `u\72l(` is a literal backslash in an ident, not `url(`;
 * - external loads: `@import` goes, and a `url()` whose argument is not a
 *   same-document fragment becomes `url-removed(` — `url(#arrow)` for a
 *   marker or gradient survives.
 */
export function standaloneCss(css: string): string {
  return css
    .replace(/\\/g, '\\\\')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\((\s*['"]?\s*)([^'")\s]*)/gi, (whole, lead: string, arg: string) =>
      arg.startsWith('#') ? whole : `url-removed(${lead}${arg}`,
    )
    .replace(/</g, '\\3c ')
    .replace(/&/g, '\\26 ');
}

/**
 * Turn a sanitized svg block into a file that stands on its own: the
 * `xmlns` (and `xmlns:xlink` when `xlink:` attributes occur) a standalone
 * document needs, the block's CSS embedded as the root's first `<style>`
 * child (`standaloneCss`), and every `--wf-*` token resolved to its light
 * literal. Pure string work on already-sanitized markup — external
 * references were dropped by `sanitizeSvg`, so nothing here re-inspects them.
 */
export function standaloneSvg(sanitizedSvg: string, css?: string): string {
  let out = sanitizedSvg.trim();
  const root = svgRootTag(out);
  if (!root) return resolveWfTokens(out);
  let tag = root.tag;
  if (/\sxlink:/i.test(out) && !/\sxmlns:xlink\s*=/i.test(tag)) {
    tag = tag.replace(/^<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  if (!/\sxmlns\s*=/i.test(tag)) {
    tag = tag.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  const rules = standaloneCss(css ?? '');
  const style = rules.trim() === '' ? '' : `\n<style>${rules}</style>`;
  out = `${tag}${style}${out.slice(root.end)}`;
  // DOMPurify serialises through the HTML serialiser, whose one non-XML
  // entity is `&nbsp;`; a standalone .svg is XML, so spell it numerically.
  return resolveWfTokens(out).replace(/&nbsp;/g, '&#160;');
}

/**
 * Replace `data-icon` markers with a small inline SVG (our own trusted
 * markup, inserted after sanitization). The set covers the icon names the
 * wireframe reference allows; unknown names get a neutral dot so the layout
 * holds. Each glyph is a 16×16 stroke path in `currentColor`.
 */
export function injectIcons(container: HTMLElement): void {
  for (const el of container.querySelectorAll('[data-icon]')) {
    const name = el.getAttribute('data-icon') ?? '';
    el.classList.add('wf-icon');
    el.innerHTML = iconSvg(name);
  }
}

function iconSvg(name: string): string {
  const path = ICON_PATHS[ICON_ALIASES[name] ?? name] ?? 'M8 7a1.5 1.5 0 100 3 1.5 1.5 0 000-3z';
  return (
    '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`
  );
}

const ICON_ALIASES: Record<string, string> = {
  email: 'mail',
  password: 'lock',
  add: 'plus',
  close: 'x',
  more: 'dots',
  chevron: 'chevronDown',
  caret: 'chevronDown',
  dropdown: 'chevronDown',
};

const ICON_PATHS: Record<string, string> = {
  mail: 'M2 4h12v8H2z M2 5l6 4 6-4',
  lock: 'M4 7h8v6H4z M6 7V5a2 2 0 014 0v2',
  search: 'M7 3a4 4 0 100 8 4 4 0 000-8z M10 10l3.5 3.5',
  plus: 'M8 3v10 M3 8h10',
  x: 'M4 4l8 8 M12 4l-8 8',
  check: 'M3 8.5l3.5 3.5L13 5',
  chevronDown: 'M4 6l4 4 4-4',
  chevronUp: 'M4 10l4-4 4 4',
  chevronLeft: 'M10 4L6 8l4 4',
  chevronRight: 'M6 4l4 4-4 4',
  dots: 'M4 8h.01 M8 8h.01 M12 8h.01',
  user: 'M8 3a2.5 2.5 0 100 5 2.5 2.5 0 000-5z M3 13c1-2.5 3-3.5 5-3.5s4 1 5 3.5',
  settings:
    'M8 6a2 2 0 100 4 2 2 0 000-4z M8 2v2 M8 12v2 M2 8h2 M12 8h2 M4 4l1.4 1.4 M10.6 10.6L12 12 M12 4l-1.4 1.4 M5.4 10.6L4 12',
  calendar: 'M3 4h10v9H3z M3 7h10 M6 2v3 M10 2v3',
  bell: 'M4 11V7a4 4 0 018 0v4l1 2H3z M7 13a1 1 0 002 0',
  send: 'M2 8l12-5-4 12-2.5-4.5z',
  edit: 'M9 3l4 4-7 7H2v-4z',
  arrowLeft: 'M13 8H3 M7 4L3 8l4 4',
  arrowRight: 'M3 8h10 M9 4l4 4-4 4',
};
