/**
 * Resolve pty byte streams into their "visible" text form, suitable for
 * substring search in the Logs pane.
 *
 * The raw JSONL records produced by `terminal-logger` are faithful pty
 * capture — they preserve ANSI escape sequences, backspaces, kill-line
 * controls, and so on. Grepping that directly is hostile: a user who
 * typed `gi<BS>t push` and then hit Enter ends up with the literal bytes
 * `gi\bt push\r` on disk, which doesn't match the search query `git
 * push`. These helpers produce the searchable / displayable form so the
 * UI (and any external grep over the JSONL `text` field) sees what the
 * user actually meant.
 *
 * Trade-off: we don't run a full terminal emulator. Output keeps its
 * structural newlines but cursor-motion sequences are stripped, not
 * replayed — which means a `clear` or full-screen redraw shows up as
 * the literal byte sequence that drew it. Worth accepting; users who
 * need pixel-accurate replay open the file in the xterm-readonly viewer
 * (still on the deferred-features list).
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/** Strip ANSI / CSI / OSC escape sequences. Pulled out so tests can verify
 * the regex doesn't drop printable characters. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Resolve input-stream edit characters so search matches what was typed.
 *
 *   - `\b` (BS, U+0008) or `\x7f` (DEL): remove the previous character
 *   - `\x15` (NAK, Ctrl+U): kill back to start of line
 *   - `\x17` (ETB, Ctrl+W): kill the last whitespace-delimited word
 *   - `\r` is kept (it's the Enter signal the writer flushes on)
 *
 * ANSI is stripped first because some shells emit `\b\x1b[K` (backspace
 * + clear-to-end-of-line) for a single delete — without stripping, the
 * CSI sequence would slip through as literal bytes.
 */
export function canonicalizeInput(raw: string): string {
  const cleaned = stripAnsi(raw);
  const out: string[] = [];
  for (const ch of cleaned) {
    if (ch === '\b' || ch === '\x7f') {
      if (out.length > 0) out.pop();
    } else if (ch === '\x15') {
      // Ctrl+U: erase back to start of the current logical line.
      while (out.length > 0 && out[out.length - 1] !== '\n' && out[out.length - 1] !== '\r') {
        out.pop();
      }
    } else if (ch === '\x17') {
      // Ctrl+W: erase one word. First any trailing whitespace, then
      // chars up to (but not including) the next whitespace / newline.
      while (out.length > 0 && /\s/.test(out[out.length - 1]) && out[out.length - 1] !== '\n') {
        out.pop();
      }
      while (out.length > 0 && !/\s/.test(out[out.length - 1])) {
        out.pop();
      }
    } else {
      out.push(ch);
    }
  }
  return out.join('');
}

/**
 * Searchable / displayable form of pty output: strip ANSI escapes and
 * normalise stray `\r` (without a following `\n`) to nothing — most
 * shells emit `\r` only as part of `\r\n` line endings or progress-bar
 * redraws; neither is interesting for substring search.
 */
export function canonicalizeOutput(raw: string): string {
  return stripAnsi(raw).replace(/\r(?!\n)/g, '');
}
