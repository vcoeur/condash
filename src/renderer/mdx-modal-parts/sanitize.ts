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
        // `#` as an in-document anchor no-op.
        if (node.tagName === 'A') node.setAttribute('href', '#');
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
