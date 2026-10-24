import type { IBufferRange, ILinkHandler, Terminal } from '@xterm/xterm';
import { terminalDocumentPath } from '@shared/terminal-document-uri';

export const TERMINAL_DOCUMENT_EVENT = 'condash-terminal-document';

interface HoveredDocument {
  uri: string;
  range: IBufferRange;
}

function sameDocumentLink(current: HoveredDocument, previous: HoveredDocument): boolean {
  return (
    current.uri === previous.uri &&
    current.range.start.x === previous.range.start.x &&
    current.range.start.y === previous.range.start.y &&
    current.range.end.x === previous.range.end.x &&
    current.range.end.y === previous.range.end.y
  );
}

/** Own local clicks before PTY reporting; hand drags back to xterm's ordinary mouse path. */
export function terminalDocumentLinks(
  term: Terminal,
  host: HTMLElement,
  sessionId: string,
): { handler: ILinkHandler; dispose(): void } {
  let hovered: HoveredDocument | null = null;
  let pending: {
    link: HoveredDocument;
    down: MouseEvent;
    target: EventTarget;
    dragged: boolean;
  } | null = null;
  let replaying = false;

  const contains = (event: MouseEvent, link: HoveredDocument): boolean => {
    const screen = term.element?.querySelector('.xterm-screen');
    if (!screen) return false;
    const bounds = screen.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    const x = Math.floor(((event.clientX - bounds.left) / bounds.width) * term.cols) + 1;
    const viewportRow = Math.floor(((event.clientY - bounds.top) / bounds.height) * term.rows) + 1;
    if (x < 1 || x > term.cols || viewportRow < 1 || viewportRow > term.rows) return false;
    const y = viewportRow + term.buffer.active.viewportY;
    const { start, end } = link.range;
    return (
      y >= start.y && y <= end.y && (y !== start.y || x >= start.x) && (y !== end.y || x <= end.x)
    );
  };
  const consume = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const down = (event: MouseEvent): void => {
    if (replaying || event.button !== 0 || event.shiftKey || !hovered || !contains(event, hovered))
      return;
    pending = { link: hovered, down: event, target: event.target ?? host, dragged: false };
    consume(event);
    term.focus();
  };
  const move = (event: MouseEvent): void => {
    if (!pending || pending.dragged) return;
    if (Math.hypot(event.clientX - pending.down.clientX, event.clientY - pending.down.clientY) < 4)
      return;
    pending.dragged = true;
    // Delay only the potential click. Once it is a drag, restore its original
    // down position before xterm receives the current move and eventual release.
    replaying = true;
    try {
      pending.target.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: pending.down.clientX,
          clientY: pending.down.clientY,
          button: 0,
          buttons: 1,
          detail: pending.down.detail,
          ctrlKey: pending.down.ctrlKey,
          metaKey: pending.down.metaKey,
          altKey: pending.down.altKey,
          shiftKey: pending.down.shiftKey,
        }),
      );
    } finally {
      replaying = false;
    }
  };
  const up = (event: MouseEvent): void => {
    if (!pending || event.button !== 0) return;
    const gesture = pending;
    pending = null;
    if (gesture.dragged) return;
    consume(event);
    if (
      event.shiftKey ||
      !hovered ||
      !sameDocumentLink(hovered, gesture.link) ||
      !contains(event, hovered)
    )
      return;
    window.dispatchEvent(
      new CustomEvent(TERMINAL_DOCUMENT_EVENT, {
        detail: { sessionId, uri: gesture.link.uri },
      }),
    );
  };
  const clear = (): void => {
    hovered = null;
  };
  const blur = (): void => {
    pending = null;
  };
  host.addEventListener('mousedown', down, true);
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
  window.addEventListener('blur', blur);
  host.addEventListener('mouseleave', clear);
  const resized = term.onResize(clear);
  const scrolled = term.onScroll(clear);

  return {
    handler: {
      allowNonHttpProtocols: true,
      activate(event, uri) {
        // Local activation belongs exclusively to the capture gate, including
        // after a drag or Shift-selection; never replay it from Linkifier.
        if (terminalDocumentPath(uri) !== null) return;
        if (/^https?:\/\//i.test(uri) || /^mailto:/i.test(uri)) {
          // A mouse-reporting TUI owns the plain OSC-link gesture. Advertising
          // OSC 8 must not add a second browser launch beside its own opener.
          if (
            term.modes.mouseTrackingMode !== 'none' &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey
          )
            return;
          event.preventDefault();
          void window.condash.openExternal(uri);
        }
      },
      hover(_event, uri, range) {
        hovered =
          terminalDocumentPath(uri) === null
            ? null
            : {
                uri,
                range: { start: { ...range.start }, end: { ...range.end } },
              };
      },
      leave: clear,
    },
    dispose() {
      pending = null;
      host.removeEventListener('mousedown', down, true);
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('blur', blur);
      host.removeEventListener('mouseleave', clear);
      resized.dispose();
      scrolled.dispose();
    },
  };
}
