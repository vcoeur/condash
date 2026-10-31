import type { IBufferRange, ILinkHandler, Terminal } from '@xterm/xterm';
import { terminalDocumentPath } from '@shared/terminal-document-uri';

export const TERMINAL_DOCUMENT_EVENT = 'condash-terminal-document';

interface HoveredLink {
  uri: string;
  range: IBufferRange;
}

function sameDocumentLink(current: HoveredLink, previous: HoveredLink): boolean {
  return (
    current.uri === previous.uri &&
    current.range.start.x === previous.range.start.x &&
    current.range.start.y === previous.range.start.y &&
    current.range.end.x === previous.range.end.x &&
    current.range.end.y === previous.range.end.y
  );
}

const externalLink = (uri: string): boolean => /^(https?|mailto):/i.test(uri);

/** Own document and modified reporting-mode web clicks before PTY reporting; replay drags. */
export function terminalDocumentLinks(
  term: Terminal,
  host: HTMLElement,
  sessionId: string,
): { handler: ILinkHandler; dispose(): void } {
  let hovered: HoveredLink | null = null;
  let pending: {
    link: HoveredLink;
    down: MouseEvent;
    target: EventTarget;
    dragged: boolean;
  } | null = null;
  let replaying = false;
  let capturedGesture = false;

  const contains = (event: MouseEvent, link: HoveredLink): boolean => {
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
    if (replaying || event.button !== 0) return;
    capturedGesture = false;
    if (event.shiftKey || !hovered || !contains(event, hovered)) return;
    if (
      terminalDocumentPath(hovered.uri) === null &&
      (term.modes.mouseTrackingMode === 'none' || (!event.ctrlKey && !event.metaKey))
    )
      return;
    pending = { link: hovered, down: event, target: event.target ?? host, dragged: false };
    capturedGesture = true;
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
    if (terminalDocumentPath(gesture.link.uri) !== null) {
      window.dispatchEvent(
        new CustomEvent(TERMINAL_DOCUMENT_EVENT, {
          detail: { sessionId, uri: gesture.link.uri },
        }),
      );
    } else {
      void window.condash.openExternal(gesture.link.uri);
    }
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
        // Linkifier can retain a prior down-link after capture or blur. Original
        // ownership survives fallback until the next genuine (not replayed) down.
        if (terminalDocumentPath(uri) !== null || capturedGesture) return;
        if (externalLink(uri) && !event.shiftKey) {
          // A mouse-reporting TUI owns the plain OSC-link gesture. Advertising
          // OSC 8 must not add a second browser launch beside its own opener.
          // Ctrl/Meta belongs exclusively to capture, including cancelled clicks
          // and replayed drags. Keep the existing Alt-only fallback with xterm.
          if (
            term.modes.mouseTrackingMode !== 'none' &&
            (event.ctrlKey || event.metaKey || !event.altKey)
          )
            return;
          event.preventDefault();
          void window.condash.openExternal(uri);
        }
      },
      hover(_event, uri, range) {
        hovered =
          terminalDocumentPath(uri) === null && !externalLink(uri)
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
