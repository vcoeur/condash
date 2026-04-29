// Shared xterm mounting helper. Both the bottom "My terms" pane and the
// Code tab's inline runner rows attach an xterm to a host element and stream
// data through the same termWrite / termResize / onTermData IPC. Putting the
// setup in one place avoids drift between the two surfaces.

import { Terminal, type FontWeight, type IDecoration, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { SerializeAddon } from '@xterm/addon-serialize';
import { ImageAddon } from '@xterm/addon-image';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import '@xterm/xterm/css/xterm.css';

import type { TerminalXtermPrefs } from '@shared/types';

export type XtermPrefs = TerminalXtermPrefs;

export interface MountedTerm {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  /** Cwd parsed from OSC 7 (`file://host/path`). null until the shell emits one. */
  cwd: () => string | null;
  /** Subscribe to cwd changes (OSC 7). Returns an unsubscribe fn. */
  onCwdChange(handler: (cwd: string) => void): () => void;
  /** Most recent prompt's exit code, if OSC 133 D was emitted. */
  lastExitCode: () => number | null;
  /** Lines (0-based, absolute buffer rows) where prompts begin (OSC 133 A). */
  promptLines: () => readonly number[];
  /** Scroll the active xterm to the previous (-1) or next (+1) prompt boundary. */
  jumpToPrompt(direction: -1 | 1): void;
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
  /** User-configured xterm preferences from configuration.json. Overrides
   * fontSize / theme when set. */
  prefs?: XtermPrefs;
  /** Renderer-side custom key hook. Return false to swallow. Stacked with the
   * built-in copy/paste handler — built-ins still run first. */
  onCustomKey?: (ev: KeyboardEvent) => boolean;
}

export function themeFromCss(): { background: string; foreground: string } {
  const css = getComputedStyle(document.documentElement);
  return {
    background: css.getPropertyValue('--bg-elevated').trim() || '#1f1f23',
    foreground: css.getPropertyValue('--text').trim() || '#ececf1',
  };
}

function buildTheme(
  prefs: XtermPrefs | undefined,
  fallback: { background: string; foreground: string },
) {
  const colors = (prefs?.colors ?? {}) as Record<string, string | undefined>;
  return {
    background: colors.background ?? fallback.background,
    foreground: colors.foreground ?? fallback.foreground,
    cursor: colors.cursor,
    cursorAccent: colors.cursor_accent,
    selectionBackground: colors.selection_background,
    black: colors.black,
    red: colors.red,
    green: colors.green,
    yellow: colors.yellow,
    blue: colors.blue,
    magenta: colors.magenta,
    cyan: colors.cyan,
    white: colors.white,
    brightBlack: colors.bright_black,
    brightRed: colors.bright_red,
    brightGreen: colors.bright_green,
    brightYellow: colors.bright_yellow,
    brightBlue: colors.bright_blue,
    brightMagenta: colors.bright_magenta,
    brightCyan: colors.bright_cyan,
    brightWhite: colors.bright_white,
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
  const prefs = options.prefs ?? {};
  const fallbackTheme = options.theme ?? themeFromCss();

  const term = new Terminal({
    fontFamily: prefs.font_family ?? 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: prefs.font_size ?? options.fontSize ?? 12,
    lineHeight: prefs.line_height ?? 1.0,
    letterSpacing: prefs.letter_spacing ?? 0,
    fontWeight: (prefs.font_weight ?? 'normal') as FontWeight,
    fontWeightBold: (prefs.font_weight_bold ?? 'bold') as FontWeight,
    theme: buildTheme(prefs, fallbackTheme),
    cursorBlink: prefs.cursor_blink ?? true,
    cursorStyle: prefs.cursor_style ?? 'block',
    scrollback: prefs.scrollback ?? 10000,
    drawBoldTextInBrightColors: false,
    allowProposedApi: true,
  });

  // ---- core addons ----
  const fit = new FitAddon();
  term.loadAddon(fit);

  const search = new SearchAddon();
  term.loadAddon(search);

  const serialize = new SerializeAddon();
  term.loadAddon(serialize);

  // OSC 8 + bare-URL detection; click via Ctrl/Cmd opens via shell.openExternal.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      void window.condash.openExternal?.(uri);
    }),
  );

  // OSC 52 host-clipboard writes from inside the terminal.
  term.loadAddon(new ClipboardAddon());

  // Unicode 11 width tables.
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  try {
    term.unicode.activeVersion = '11';
  } catch {
    /* unicode service not ready yet — Unicode11Addon registers it; ignore */
  }

  // Inline image protocols (sixel + iTerm).
  try {
    term.loadAddon(new ImageAddon());
  } catch {
    /* image addon optional */
  }

  // ---- write/data wiring + clipboard fallback for Ctrl+C/V ----
  const customKeyDisposers: IDisposable[] = [];
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
    if (options.onCustomKey) return options.onCustomKey(ev);
    return true;
  });

  term.open(hostElement);

  // ---- WebGL renderer (best-effort; falls back to DOM) ----
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* GPU unavailable; keep the default DOM renderer */
  }

  // ---- ligatures (gated; loads font-ligatures behind the scenes) ----
  if (prefs.ligatures) {
    try {
      term.loadAddon(new LigaturesAddon());
    } catch {
      /* font scan failed; not fatal */
    }
  }

  if (options.replay) term.write(options.replay);

  term.onData((data) => {
    void window.condash.termWrite(sessionId, data);
  });
  term.onResize(({ cols, rows }) => {
    void window.condash.termResize(sessionId, cols, rows);
  });

  // ---- OSC 7 cwd tracking ----
  let cwd: string | null = null;
  const cwdHandlers = new Set<(cwd: string) => void>();
  term.parser.registerOscHandler(7, (data) => {
    // Format: file://host/path-with-percent-encoded-bytes
    const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (!match) return false;
    try {
      const decoded = decodeURIComponent(match[1]);
      cwd = decoded;
      for (const h of cwdHandlers) h(decoded);
    } catch {
      /* malformed payload */
    }
    return true;
  });

  // ---- OSC 133 prompt boundary tracking ----
  // A = prompt-start, B = prompt-end (input begins), C = command-start (output
  // begins), D = command-end + optional exit code: "133;D;<exit>".
  const promptLines: number[] = [];
  const promptDecorations: IDecoration[] = [];
  let lastExitCode: number | null = null;
  const trimPromptHistory = (): void => {
    // Keep the list bounded to what's still in the scrollback.
    const minLine = term.buffer.active.baseY;
    while (promptLines.length > 0 && promptLines[0] < minLine) {
      promptLines.shift();
      const dec = promptDecorations.shift();
      dec?.dispose();
    }
  };
  const markPromptDecoration = (line: number, exit: number | null): void => {
    try {
      const marker = term.registerMarker(
        line - (term.buffer.active.baseY + term.buffer.active.cursorY),
      );
      if (!marker) return;
      const dec = term.registerDecoration({ marker, x: 0, width: 1, layer: 'top' });
      if (!dec) return;
      dec.onRender((el) => {
        const colour = exit === null ? 'var(--accent)' : exit === 0 ? '#3fb950' : '#f85149';
        el.style.background = colour;
        el.style.opacity = '0.85';
        el.style.borderRadius = '1px';
      });
      promptDecorations.push(dec);
    } catch {
      /* decoration failures are non-fatal */
    }
  };
  term.parser.registerOscHandler(133, (data) => {
    const parts = data.split(';');
    const kind = parts[0];
    const buf = term.buffer.active;
    const line = buf.baseY + buf.cursorY;
    if (kind === 'A') {
      promptLines.push(line);
      markPromptDecoration(line, lastExitCode);
      trimPromptHistory();
    } else if (kind === 'D') {
      const code = parts[1] !== undefined ? Number(parts[1]) : null;
      lastExitCode = Number.isFinite(code) ? (code as number) : null;
      // Decorate the most recent prompt with the resolved exit code.
      const lastIdx = promptLines.length - 1;
      if (lastIdx >= 0) {
        promptDecorations[lastIdx]?.dispose();
        markPromptDecoration(promptLines[lastIdx], lastExitCode);
      }
    }
    // 'B' (prompt-end) and 'C' (command-start) currently only used as data
    // boundaries; no decoration needed.
    return true;
  });

  const jumpToPrompt = (direction: -1 | 1): void => {
    const buf = term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    const sorted = [...promptLines].sort((a, b) => a - b);
    let target: number | null = null;
    if (direction < 0) {
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i] < cursorAbs) {
          target = sorted[i];
          break;
        }
      }
    } else {
      for (const line of sorted) {
        if (line > cursorAbs) {
          target = line;
          break;
        }
      }
    }
    if (target === null) return;
    // scrollToLine takes a viewport-relative offset; convert.
    term.scrollToLine(Math.max(0, target - term.rows + 1));
  };

  let disposed = false;
  return {
    term,
    fit,
    search,
    serialize,
    cwd: () => cwd,
    onCwdChange: (handler) => {
      cwdHandlers.add(handler);
      return () => cwdHandlers.delete(handler);
    },
    lastExitCode: () => lastExitCode,
    promptLines: () => promptLines,
    jumpToPrompt,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const d of customKeyDisposers) d.dispose();
      for (const d of promptDecorations) d.dispose();
      term.dispose();
    },
  };
}
