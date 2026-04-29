/**
 * Click router for links inside rendered markdown views (note + help modals).
 *
 * markdown-it produces plain `<a href>` elements for `[text](path)` links, plus
 * autolinks when `linkify: true`. Without an interceptor, clicking any of these
 * triggers Electron's default navigation, replacing the renderer with whatever
 * the href resolves to — for relative file paths that's a blank window. The
 * router below catches every `<a>` click in a markdown body, classifies the
 * href, and dispatches to the right handler.
 *
 * Wikilink elements (`a.wikilink`, emitted by the wikilinks markdown-it rule)
 * are still routed through the dedicated `onWikilink` callback so they can hit
 * the slug index. The router is not a replacement for that path — it composes
 * with it.
 */

export interface MdLinkCallbacks {
  /** Wikilink slug — passed verbatim to the existing slug index lookup. */
  onWikilink?: (slug: string) => void;
  /** External URL (http/https/mailto). Should hand off to the OS browser. */
  onExternal?: (url: string) => void;
  /** Anchor target inside the current document — string is the id (no `#`). */
  onAnchor?: (id: string) => void;
  /** Resolved absolute path to a `.md` file referenced by a relative link. */
  onMarkdown?: (absPath: string) => void;
  /** Resolved absolute path to a `.pdf`. */
  onPdf?: (absPath: string) => void;
  /** Resolved absolute path to anything else (image, dir, unknown ext). */
  onOtherFile?: (absPath: string) => void;
}

/**
 * Resolve a relative or absolute href against the directory of `currentFile`.
 * `currentFile` must be an absolute POSIX path. Returns an absolute POSIX path.
 * The query/hash portion of the href is stripped — callers don't act on it.
 */
export function resolvePath(currentFile: string, href: string): string {
  const cleaned = href.split('#')[0].split('?')[0];
  if (cleaned.startsWith('/')) return normalize(cleaned);
  const dir = currentFile.replace(/\/[^/]*$/, '');
  return normalize(`${dir}/${cleaned}`);
}

function normalize(path: string): string {
  const isAbsolute = path.startsWith('/');
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return (isAbsolute ? '/' : '') + out.join('/');
}

/**
 * Pointer to the current document, used to resolve relative paths. `null`
 * means relative paths cannot be resolved (help modal, where docs live in the
 * app bundle rather than on disk) — relative refs are then dropped silently
 * after preventDefault, so they at least no longer blank the window.
 */
export type CurrentDoc = { path: string } | null;

/**
 * Handle a click on a markdown body. Always preventDefault on `<a>` clicks so
 * Electron never gets a chance to navigate the renderer. Returns `true` when
 * an `<a>` was handled (so the caller can short-circuit other click logic).
 */
export function routeMarkdownClick(
  e: MouseEvent,
  currentDoc: CurrentDoc,
  cb: MdLinkCallbacks,
): boolean {
  const target = e.target as HTMLElement | null;
  const link = target?.closest('a');
  if (!link) return false;

  // Anything that's an anchor element gets its default navigation suppressed,
  // even if we end up doing nothing else with it. That is the safety net.
  e.preventDefault();

  if (link.classList.contains('wikilink')) {
    const slug = link.getAttribute('data-slug');
    if (slug && cb.onWikilink) cb.onWikilink(slug);
    return true;
  }

  const href = link.getAttribute('href');
  if (!href || href === '#') return true;

  if (/^(https?|mailto):/i.test(href)) {
    cb.onExternal?.(href);
    return true;
  }

  if (href.startsWith('#')) {
    cb.onAnchor?.(href.slice(1));
    return true;
  }

  // Relative or absolute file path. `file://` URLs are also normalised to a
  // bare absolute path so downstream handlers don't have to think about them.
  if (!currentDoc) return true;
  const stripped = href.replace(/^file:\/\//, '');
  const abs = resolvePath(currentDoc.path, stripped);
  const lower = abs.toLowerCase();
  if (lower.endsWith('.md')) {
    cb.onMarkdown?.(abs);
  } else if (lower.endsWith('.pdf')) {
    cb.onPdf?.(abs);
  } else {
    cb.onOtherFile?.(abs);
  }
  return true;
}

/**
 * Scroll to an element with the given id inside `container`. No-op if not
 * found. Used for `#anchor` links in rendered markdown — markdown-it-anchor
 * adds ids to headings.
 */
export function scrollToAnchor(container: HTMLElement, id: string): void {
  // CSS.escape isn't available in older test envs; fall back to manual escape.
  const escape =
    (typeof CSS !== 'undefined' && CSS.escape) ||
    ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const el = container.querySelector<HTMLElement>(`#${escape(id)}`);
  if (el) el.scrollIntoView({ block: 'start' });
}
