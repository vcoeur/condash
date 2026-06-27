/**
 * Turn raw PTY output (ANSI escape codes, carriage-return overwrites, stray
 * control bytes) into plain text legible to an LLM summarizer.
 *
 * This is deliberately NOT a faithful terminal renderer — a full-screen TUI
 * that repaints via cursor addressing (vim, htop) will read roughly. The
 * dashboard feeds line-oriented command output and coding-agent transcripts,
 * where stripping escapes and collapsing `\r` progress redraws is enough. The
 * accurate path (a headless xterm) lives in the terminal logger but only runs
 * when on-disk logging is enabled; the dashboard must work either way, so it
 * cleans the rolling raw buffer instead.
 */
// Control-character ranges we drop (everything below 0x20 except \n and \t,
// plus DEL). Declared once; the `\r` overwrite pass runs before this so lone
// carriage returns are resolved rather than deleted.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// OSC: ESC ] ... terminated by BEL or ESC \. Stripped first so the BEL
// terminator is consumed here rather than by the control-char pass.
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// CSI: ESC [ params intermediate final.
const CSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Other two-byte escapes: ESC followed by a single byte in @-_ or \.
const SHORT_ESCAPE = /\x1b[@-Z\\-_]/g;
// ECMA-48 "nF" escapes: ESC + one-or-more intermediate bytes (0x20-0x2F) + a
// final byte (0x30-0x7E). Covers charset designation (ESC ( B, ESC ) 0), DEC
// line alignment (ESC # 8), UTF-8 select (ESC % G), etc. Without this the lone
// ESC is later removed by the CONTROL_CHARS pass and the intermediate+final
// bytes (e.g. "(B") leak into the cleaned text as repeated literal residue —
// an alternate-screen TUI emits ESC ( B on every repaint, so the summarizer
// would otherwise "see" a tab printing "(B" over and over.
const NF_ESCAPE = /\x1b[\x20-\x2f]+[\x30-\x7e]/g;

/**
 * Clean raw terminal output into plain text.
 *
 * @param raw - Raw bytes captured from the PTY stream.
 * @returns Plain text with escapes removed, `\r` overwrites resolved, runs of
 *   blank lines collapsed, and trailing whitespace trimmed.
 */
export function cleanTerminalText(raw: string): string {
  // Normalise CRLF first so a real newline isn't mistaken for an overwrite.
  let text = raw.replace(/\r\n/g, '\n');
  text = text.replace(OSC_SEQUENCE, '');
  text = text.replace(CSI_SEQUENCE, '');
  // Strip nF escapes before the CONTROL_CHARS pass below, which would otherwise
  // delete only the lone ESC and leave the printable "(B" tail behind.
  text = text.replace(NF_ESCAPE, '');
  text = text.replace(SHORT_ESCAPE, '');
  // Resolve carriage-return overwrites per line: a `\r` rewinds to column 0, so
  // the visible result of "10%\r50%\rdone" is "done". Keep the last segment.
  const lines = text.split('\n').map((line) => {
    const segments = line.split('\r');
    return segments[segments.length - 1].replace(CONTROL_CHARS, '');
  });
  return lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
