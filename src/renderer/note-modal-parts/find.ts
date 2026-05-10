/**
 * Find-in-note engine. Pure DOM helpers — walks the rendered article via
 * `document.createTreeWalker`, splices text nodes around case-insensitive
 * matches, and toggles a "current" class on the active hit. No SolidJS ties:
 * the modal owns the `findOpen` / `findQuery` / `findMatch` signals and
 * calls these helpers via a debounced effect.
 */

export const FIND_HIGHLIGHT_CLASS = 'find-hit';
export const FIND_CURRENT_CLASS = 'find-current';

export function clearFindHighlights(container: HTMLElement): void {
  for (const el of Array.from(
    container.querySelectorAll<HTMLElement>(`.${FIND_HIGHLIGHT_CLASS}`),
  )) {
    const parent = el.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(el.textContent ?? ''), el);
    parent.normalize();
  }
}

export function highlightFindMatches(container: HTMLElement, query: string): number {
  const lower = query.toLowerCase();
  if (lower.length === 0) return 0;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Skip script/style/find-bar (UI noise) and SVG subtrees (mermaid
      // diagrams render text as <text> nodes inside <svg>; replacing them
      // with split <span> wrappers blows up the diagram's layout).
      if (parent.closest('script, style, svg, .find-bar')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.toLowerCase().includes(lower)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  let cur: Node | null = walker.nextNode();
  while (cur) {
    targets.push(cur as Text);
    cur = walker.nextNode();
  }

  let count = 0;
  for (const node of targets) {
    const text = node.nodeValue ?? '';
    const fragment = document.createDocumentFragment();
    const lowerText = text.toLowerCase();
    let cursor = 0;
    let next = lowerText.indexOf(lower, cursor);
    while (next !== -1) {
      if (next > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, next)));
      const span = document.createElement('span');
      span.className = FIND_HIGHLIGHT_CLASS;
      span.textContent = text.slice(next, next + query.length);
      fragment.appendChild(span);
      count++;
      cursor = next + query.length;
      next = lowerText.indexOf(lower, cursor);
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  }
  return count;
}

export function focusFindMatch(container: HTMLElement, index: number): void {
  const hits = container.querySelectorAll<HTMLElement>(`.${FIND_HIGHLIGHT_CLASS}`);
  for (const hit of Array.from(hits)) hit.classList.remove(FIND_CURRENT_CLASS);
  const target = hits[index];
  if (!target) return;
  target.classList.add(FIND_CURRENT_CLASS);
  target.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
}
