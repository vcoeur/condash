import { describe, expect, it } from 'vitest';
import { MAX_TRANSCRIPT_CHARS, sanitizeTranscript } from './transcript';

describe('sanitizeTranscript', () => {
  it('passes plain text through untouched', () => {
    expect(sanitizeTranscript('make test and run npm run dev')).toBe(
      'make test and run npm run dev',
    );
  });

  it('keeps newlines, tabs and non-ASCII letters', () => {
    expect(sanitizeTranscript('first line\nsecond\tcol — café 東字')).toBe(
      'first line\nsecond\tcol — café 東字',
    );
  });

  it('strips C0 control characters (Ctrl-C, EOF, bell)', () => {
    expect(sanitizeTranscript('ls\x03-la\x04foo\x07bar')).toBe('ls-lafoobar');
  });

  it('strips DEL', () => {
    expect(sanitizeTranscript('ab\x7fc')).toBe('abc');
  });

  it('removes carriage returns so nothing mid-transcript re-submits a line', () => {
    expect(sanitizeTranscript('one\r\ntwo\rthree')).toBe('one\ntwothree');
  });

  it('strips ANSI/CSI escape sequences', () => {
    expect(sanitizeTranscript('\x1b[31mred\x1b[0m plain')).toBe('red plain');
    expect(sanitizeTranscript('\x1b]0;title\x07tail')).toBe('tail');
  });

  it('collapses blank-line runs to one blank line', () => {
    expect(sanitizeTranscript('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeTranscript('  \n hello \n ')).toBe('hello');
  });

  it('caps at MAX_TRANSCRIPT_CHARS', () => {
    const long = 'x'.repeat(MAX_TRANSCRIPT_CHARS + 500);
    expect(sanitizeTranscript(long)).toHaveLength(MAX_TRANSCRIPT_CHARS);
  });

  it('honours a custom cap', () => {
    expect(sanitizeTranscript('abcdef', 3)).toBe('abc');
  });

  it('returns empty for empty, whitespace-only and control-only input', () => {
    expect(sanitizeTranscript('')).toBe('');
    expect(sanitizeTranscript('   \n  ')).toBe('');
    expect(sanitizeTranscript('\x03\x04')).toBe('');
  });
});
