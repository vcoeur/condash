// Shared xterm mounting helper. Both the bottom "My terms" pane and the
// Code tab's inline runner rows attach an xterm to a host element and stream
// data through the same termWrite / termResize / onTermData IPC. Putting the
// setup in one place avoids drift between the two surfaces.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface MountedTerm {
  term: Terminal;
  fit: FitAddon;
  /** Tear down the xterm. Idempotent — safe to call from both onCleanup and
   * an explicit detach (e.g. when re-siding a session). */
  dispose(): void;
}

interface MountOptions {
  /** Pixel font size — bottom pane uses 12, inline Code-tab runners use 12 too
   * but expose this so future tweaks don't have to fork the helper. */
  fontSize?: number;
  /** Buffered tail to write before live data starts arriving. Comes from
   * `term.attach` when re-attaching to an existing pty. */
  replay?: string;
  /** Theme override; defaults to reading CSS custom properties. */
  theme?: { background: string; foreground: string };
}

export function themeFromCss(): { background: string; foreground: string } {
  const css = getComputedStyle(document.documentElement);
  return {
    background: css.getPropertyValue('--bg-elevated').trim() || '#1f1f23',
    foreground: css.getPropertyValue('--text').trim() || '#ececf1',
  };
}

/** Build an xterm bound to a session id, attach it to the given host element,
 * wire write/resize/data handlers + Ctrl+C-copy / Ctrl+V-paste, and replay
 * any buffered tail. The caller still owns visibility (display: none/flex)
 * and focus management. */
export function mountXterm(
  hostElement: HTMLElement,
  sessionId: string,
  options: MountOptions = {},
): MountedTerm {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: options.fontSize ?? 12,
    theme: options.theme ?? themeFromCss(),
    cursorBlink: true,
    scrollback: 4000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  // Ctrl+C copies when there's a selection (otherwise default = SIGINT to
  // the pty). Ctrl+V pastes the clipboard. Returning false stops xterm from
  // processing the event itself.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const ctrl = ev.ctrlKey && !ev.metaKey;
    if (ctrl && !ev.shiftKey && !ev.altKey && (ev.key === 'c' || ev.key === 'C')) {
      const sel = term.getSelection();
      if (sel && sel.length > 0) {
        ev.preventDefault();
        void navigator.clipboard.writeText(sel).catch(() => undefined);
        term.clearSelection();
        return false;
      }
      return true;
    }
    if (ctrl && !ev.shiftKey && !ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
      ev.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) void window.condash.termWrite(sessionId, text);
        })
        .catch(() => undefined);
      return false;
    }
    return true;
  });

  term.open(hostElement);
  if (options.replay) term.write(options.replay);

  term.onData((data) => {
    void window.condash.termWrite(sessionId, data);
  });
  term.onResize(({ cols, rows }) => {
    void window.condash.termResize(sessionId, cols, rows);
  });

  let disposed = false;
  return {
    term,
    fit,
    dispose() {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },
  };
}
