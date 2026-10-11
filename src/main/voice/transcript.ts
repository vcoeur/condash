// Transcript sanitisation for PTY insertion.
//
// A dictated transcript is about to be written into a terminal's PTY input,
// exactly as typed keystrokes would be. The shell on the other end must never
// see control characters a mic never captured (a stray 0x03 is Ctrl-C, 0x04
// is EOF): everything below 0x20 is stripped except `\n` and `\t`, `\r` goes
// (CR would re-submit the current line mid-transcript), and ANSI/CSI escape
// sequences are dropped in case a provider ever echoes terminal markup.

/** Hard cap on characters written to the PTY in one dictation. Speech clips
 *  are seconds long; 4000 chars is far past anything a push-to-talk utterance
 *  produces while bounding a stuck-open mic or a pathological provider. */
export const MAX_TRANSCRIPT_CHARS = 4000;

/** CSI sequences (\x1b[…final), OSC strings (\x1b]…\x07 or …\x1b\\), and any
 *  other lone ESC-followed byte. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;

/**
 * Reduce a raw transcript to safe terminal input: providers' ANSI/control
 * noise stripped, `\r` removed, blank-line runs collapsed, trimmed, and
 * capped to `maxChars`. Returns the empty string when nothing usable
 * remains — the caller turns that into a no-op with a visible notice.
 */
export function sanitizeTranscript(raw: string, maxChars: number = MAX_TRANSCRIPT_CHARS): string {
  if (!raw) return '';
  let text = raw.replace(ANSI_RE, '');
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '\n' || ch === '\t') {
      out += ch;
    } else if (code < 0x20 || code === 0x7f) {
      // Every other C0 control plus DEL: strip. Higher code points
      // (accents, CJK, emoji) pass through untouched.
      continue;
    } else {
      out += ch;
    }
  }
  out = out
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}
