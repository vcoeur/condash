import { describe, expect, it } from 'vitest';
import { cleanTerminalText } from './clean-text';

describe('cleanTerminalText', () => {
  it('strips CSI colour / SGR sequences', () => {
    expect(cleanTerminalText('\x1b[31mred\x1b[0m text')).toBe('red text');
  });

  it('strips OSC title sequences (BEL- and ST-terminated)', () => {
    expect(cleanTerminalText('\x1b]0;my title\x07hello')).toBe('hello');
    expect(cleanTerminalText('\x1b]8;;https://x\x1b\\link')).toBe('link');
  });

  it('resolves carriage-return progress overwrites to the final state', () => {
    expect(cleanTerminalText('10%\r50%\rdone')).toBe('done');
  });

  it('keeps CRLF as a normal newline', () => {
    expect(cleanTerminalText('line one\r\nline two')).toBe('line one\nline two');
  });

  it('drops stray control bytes but keeps tabs and newlines', () => {
    expect(cleanTerminalText('a\x07b\tc\nd')).toBe('ab\tc\nd');
  });

  it('collapses runs of blank lines and trims edges', () => {
    expect(cleanTerminalText('\n\nfoo\n\n\n\nbar\n\n')).toBe('foo\n\nbar');
  });

  it('returns empty string for escape-only input', () => {
    expect(cleanTerminalText('\x1b[2J\x1b[H')).toBe('');
  });

  it('consumes nF charset-designation escapes instead of leaking "(B"', () => {
    // ESC ( B = "designate G0 = US-ASCII"; the printable "(B" tail must not survive.
    expect(cleanTerminalText('\x1b(Bhello')).toBe('hello');
    expect(cleanTerminalText('\x1b(B\x1b)0\x1b*B\x1b+B')).toBe('');
    expect(cleanTerminalText('\x1b#8aligned')).toBe('aligned');
  });

  it('cleans an alternate-screen repaint frame to empty (no "(B" residue)', () => {
    // Regression: a TUI repainting via cursor addressing emits ESC ( B every
    // frame; the cleaned text must not read as a tab printing "(B" repeatedly.
    const frame = '\x1b[H\x1b(B\x1b[2K\x1b(B'.repeat(6);
    const cleaned = cleanTerminalText(frame);
    expect(cleaned).not.toContain('(B');
    expect(cleaned).toBe('');
  });
});
