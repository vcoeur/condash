// Shared xterm mounting helper. Both the bottom "My terms" pane and the
// Code pane's inline runner rows attach an xterm to a host element and stream
// data through the same termWrite / termResize / onTermData IPC. Putting the
// setup in one place avoids drift between the two surfaces.

import { Terminal, type FontWeight, type IDecoration } from '@xterm/xterm';
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
import { liveTerms } from './xterm-registry';
import { PromptDecorations } from './prompt-decorations';
import { webglPool, type WebglSlot } from './webgl-pool';

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
  /** Most recent window title from OSC 0 / OSC 2, with the harness status
   * glyph (spinner / idle marker) stripped. null until a title is emitted. */
  termTitle: () => string | null;
  /** Subscribe to window-title changes (OSC 0 / 2). Fires only when the
   * cleaned title text changes — spinner-frame churn is coalesced. Returns an
   * unsubscribe fn. */
  onTitleChange(handler: (title: string) => void): () => void;
  /** Whether the running program reports itself busy via OSC 9;4 progress
   * (state ≠ 0). false until a progress report says otherwise. */
  progressBusy: () => boolean;
  /** Subscribe to OSC 9;4 busy/idle transitions. Returns an unsubscribe fn. */
  onProgressChange(handler: (busy: boolean) => void): () => void;
  /** Most recent prompt's exit code, if OSC 133 D was emitted. */
  lastExitCode: () => number | null;
  /** Lines (0-based, absolute buffer rows) where prompts begin (OSC 133 A). */
  promptLines: () => readonly number[];
  /** Scroll the active xterm to the previous (-1) or next (+1) prompt boundary. */
  jumpToPrompt(direction: -1 | 1): void;
  /** Re-read the current CSS theme tokens (--bg-elevated / --text) and apply
   * to this xterm. Called when the renderer flips light/dark so live terminals
   * pick up the new palette without a re-attach. User color overrides from
   * `XtermPrefs` win over the CSS fallback. */
  refreshTheme(prefs?: XtermPrefs): void;
  /** Report whether this terminal is currently visible so the shared WebGL
   * pool keeps visible terminals GPU-rendered and evicts long-hidden ones'
   * contexts (review F1 — the ~16-tab GPU-context cliff). Idempotent. */
  setVisible(visible: boolean): void;
  /** Tear down the xterm. Idempotent — safe to call from both onCleanup and
   * an explicit detach (e.g. when re-siding a session). */
  dispose(): void;
}

interface MountOptions {
  /** Pixel font size — bottom pane uses 12, inline Code-pane runners use 12 too
   * but expose this so future tweaks don't have to fork the helper. */
  fontSize?: number;
  /** Buffered tail to write before live data starts arriving. Comes from
   * `termAttach` when re-attaching to an existing pty. */
  replay?: string;
  /** Theme override; defaults to reading CSS custom properties. */
  theme?: { background: string; foreground: string };
  /** User-configured xterm preferences from condash.json. Overrides
   * fontSize / theme when set. */
  prefs?: XtermPrefs;
  /** Renderer-side custom key hook. Return false to swallow. Stacked with the
   * built-in copy/paste handler — built-ins still run first. */
  onCustomKey?: (ev: KeyboardEvent) => boolean;
}

// The live-terminal registry + refreshAllXtermThemes live in the leaf module
// `xterm-registry.ts` (no `@xterm/*` import) so use-theme can repaint terminals
// without pulling xterm into the boot chunk. mountXterm registers each term in
// `liveTerms` (added on mount, pruned on dispose).

function themeFromCss(): { background: string; foreground: string } {
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
    scrollback: prefs.scrollback ?? 5000,
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

  // ---- write/data wiring + clipboard copy/paste (Ctrl+C / Ctrl+V) ----
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
    // Ctrl+V: read the system clipboard in the main process and paste through
    // term.paste(), which applies bracketed-paste wrapping when the program
    // has that mode on (opencode's TUI relies on it to treat a multi-line
    // paste as one block). We can't lean on xterm.js's native paste here —
    // the Electron menu's paste role does not reliably deliver a paste event
    // to the hidden textarea, and navigator.clipboard.readText() is
    // permission-gated in the renderer. See the clipboardReadText IPC.
    if (ctrl && !ev.shiftKey && !ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
      ev.preventDefault();
      void window.condash
        .clipboardReadText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => undefined);
      return false;
    }
    if (options.onCustomKey) return options.onCustomKey(ev);
    return true;
  });

  term.open(hostElement);

  // ---- WebGL renderer, pooled (best-effort; falls back to DOM) ----
  // Every mounted tab used to hold its own WebGL context; past ~16 tabs the GPU
  // force-loses contexts and the retry churn below fires in a storm (review F1).
  // The context now lives in the shared `webglPool`, which caps live contexts
  // and disposes the least-recently-visible terminal's context on overflow —
  // xterm reverts to its DOM renderer, no data loss. `attach`/`detach` build and
  // dispose the addon; the pool decides when each runs. On GPU context loss
  // (driver reset, not overflow) we rebuild on the next frame — but only if the
  // pool still wants this terminal live, so recovery can't smuggle us past the
  // cap. After two losses we give up and stay on the DOM renderer.
  let currentWebgl: WebglAddon | null = null;
  let webglRetries = 0;
  const webglSlot: WebglSlot = {
    attach() {
      if (currentWebgl) return;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (currentWebgl === webgl) currentWebgl = null;
          if (webglRetries >= 2) return;
          webglRetries++;
          // Defer one frame so the GPU process can settle, then rebuild only if
          // the pool hasn't evicted us in the meantime.
          requestAnimationFrame(() => {
            if (!currentWebgl && webglPool.has(webglSlot)) webglSlot.attach();
          });
        });
        term.loadAddon(webgl);
        currentWebgl = webgl;
      } catch {
        /* GPU unavailable; keep the default DOM renderer */
      }
    },
    detach() {
      if (!currentWebgl) return;
      try {
        currentWebgl.dispose();
      } catch {
        /* already disposed */
      }
      currentWebgl = null;
    },
  };
  webglPool.touch(webglSlot);

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

  // ---- OSC 0 / OSC 2 window-title tracking ----
  // Harnesses announce a human summary of what the session is doing via the
  // window title — Claude Code emits OSC 0 like "✳ Ask about the weather".
  // xterm.js routes both OSC 0 and OSC 2 to `onTitleChange`. We strip the
  // leading status glyph (the idle ✳ and the ⠂/⠐ spinner frames that cycle
  // every animation tick) and coalesce: downstream handlers fire only when the
  // cleaned text actually changes, so spinner churn never reaches the tab —
  // this dedupe is the debounce, so no timer is needed.
  let title: string | null = null;
  const titleHandlers = new Set<(title: string) => void>();
  // Strip leading whitespace + symbol/"other" glyphs (spinner ⠂⠐, idle ✳),
  // but keep ASCII punctuation so path-like titles survive intact.
  const cleanTitle = (raw: string): string =>
    raw.replace(/^[\p{White_Space}\p{S}\p{C}]+/u, '').trim();
  term.onTitleChange((raw) => {
    const next = cleanTitle(raw);
    if (!next || next === title) return;
    title = next;
    for (const handler of titleHandlers) handler(next);
  });

  // ---- OSC 9;4 progress → tab busy/idle ----
  // ConEmu's progress protocol (`ESC ] 9 ; 4 ; <state> ; <pct> BEL`): state 0
  // clears (idle); 1/2/4 are determinate/error/paused; 3 is indeterminate.
  // Harnesses use it as a coarse busy signal — Claude emits 9;4;3 while working
  // and 9;4;0 when idle — so we collapse it to one busy flag and drop the
  // percentage. Non-progress OSC 9 (e.g. iTerm2 notifications) falls through.
  let busy = false;
  const busyHandlers = new Set<(busy: boolean) => void>();
  term.parser.registerOscHandler(9, (data) => {
    const parts = data.split(';');
    if (parts[0] !== '4') return false;
    const state = Number(parts[1]);
    const next = Number.isFinite(state) && state !== 0;
    if (next === busy) return true;
    busy = next;
    for (const handler of busyHandlers) handler(next);
    return true;
  });

  // ---- OSC 133 prompt boundary tracking ----
  // A = prompt-start, B = prompt-end (input begins), C = command-start (output
  // begins), D = command-end + optional exit code: "133;D;<exit>".
  // The prompt-line + decoration bookkeeping lives in PromptDecorations
  // (prompt-decorations.ts) so it stays index-aligned and scrollback-bounded —
  // the previous inline version pushed a second decoration entry per command,
  // growing the list for the life of the tab.
  let lastExitCode: number | null = null;
  const makePromptDecoration = (line: number, exit: number | null): IDecoration | null => {
    try {
      const marker = term.registerMarker(
        line - (term.buffer.active.baseY + term.buffer.active.cursorY),
      );
      if (!marker) return null;
      const dec = term.registerDecoration({ marker, x: 0, width: 1, layer: 'top' });
      if (!dec) return null;
      dec.onRender((el) => {
        // CSS tokens, not hex literals, so the marker colours flip with the
        // theme (the decoration element lives in the document, so `var()`
        // resolves live — no getComputedStyle snapshot needed). Success /
        // failure reuse the palette's running-green and warn-red.
        const colour =
          exit === null ? 'var(--accent)' : exit === 0 ? 'var(--col-running)' : 'var(--warn)';
        el.style.background = colour;
        el.style.opacity = '0.85';
        el.style.borderRadius = '1px';
      });
      return dec;
    } catch {
      /* decoration failures are non-fatal */
      return null;
    }
  };
  const prompts = new PromptDecorations<IDecoration>(makePromptDecoration);
  term.parser.registerOscHandler(133, (data) => {
    const parts = data.split(';');
    const kind = parts[0];
    const buf = term.buffer.active;
    const line = buf.baseY + buf.cursorY;
    if (kind === 'A') {
      prompts.start(line, lastExitCode, buf.baseY);
    } else if (kind === 'D') {
      const code = parts[1] !== undefined ? Number(parts[1]) : null;
      lastExitCode = Number.isFinite(code) ? (code as number) : null;
      // Recolour the most recent prompt with the resolved exit code.
      prompts.end(lastExitCode);
    }
    // 'B' (prompt-end) and 'C' (command-start) currently only used as data
    // boundaries; no decoration needed.
    return true;
  });

  const jumpToPrompt = (direction: -1 | 1): void => {
    const buf = term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    const sorted = [...prompts.promptLines()].sort((a, b) => a - b);
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

  // Track the user-prefs override so refreshTheme can re-merge against the
  // freshly-read CSS tokens after a light/dark flip.
  let activePrefs: XtermPrefs = prefs;
  const refreshTheme = (next?: XtermPrefs): void => {
    if (next) activePrefs = next;
    term.options.theme = buildTheme(activePrefs, themeFromCss());
  };

  let disposed = false;
  const mounted: MountedTerm = {
    term,
    fit,
    search,
    serialize,
    cwd: () => cwd,
    onCwdChange: (handler) => {
      cwdHandlers.add(handler);
      return () => cwdHandlers.delete(handler);
    },
    termTitle: () => title,
    onTitleChange: (handler) => {
      titleHandlers.add(handler);
      return () => titleHandlers.delete(handler);
    },
    progressBusy: () => busy,
    onProgressChange: (handler) => {
      busyHandlers.add(handler);
      return () => busyHandlers.delete(handler);
    },
    lastExitCode: () => lastExitCode,
    promptLines: () => prompts.promptLines(),
    jumpToPrompt,
    refreshTheme,
    setVisible(visible: boolean) {
      if (disposed) return;
      if (visible) webglPool.show(webglSlot);
      else webglPool.hide(webglSlot);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      liveTerms.delete(mounted);
      // Drop our pool slot before term.dispose() (which disposes the WebglAddon).
      webglPool.remove(webglSlot);
      prompts.dispose();
      term.dispose();
    },
  };
  liveTerms.add(mounted);
  return mounted;
}
