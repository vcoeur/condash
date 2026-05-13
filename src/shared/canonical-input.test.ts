import { describe, expect, it } from 'vitest';
import { canonicalizeInput, canonicalizeOutput, stripAnsi } from './canonical-input';

describe('stripAnsi', () => {
  it('removes CSI colour codes', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[0m')).toBe('hello');
  });

  it('removes OSC title sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07rest')).toBe('rest');
  });
});

describe('canonicalizeInput', () => {
  it('resolves a single backspace (re-typing after a typo)', () => {
    // User typed 'gi', backspaced, then typed 'it push' + Enter.
    expect(canonicalizeInput('gi\bit push\r')).toBe('git push\r');
  });

  it('resolves DEL (0x7f) the same as BS', () => {
    expect(canonicalizeInput('foo\x7fbar')).toBe('fobar');
  });

  it('resolves Ctrl+U as kill-line', () => {
    expect(canonicalizeInput('mistake\x15git push')).toBe('git push');
  });

  it('Ctrl+U stops at newline boundary', () => {
    expect(canonicalizeInput('line1\nmistake\x15kept')).toBe('line1\nkept');
  });

  it('resolves Ctrl+W as kill-word', () => {
    expect(canonicalizeInput('git remote add\x17origin')).toBe('git remote origin');
  });

  it('strips ANSI before resolving edits', () => {
    // `\b\x1b[K` (backspace + clear-to-EOL) — some shells emit this for one delete.
    expect(canonicalizeInput('foo\b\x1b[Kbar')).toBe('fobar');
  });

  it('passes printable text through unchanged', () => {
    expect(canonicalizeInput('echo hello\r')).toBe('echo hello\r');
  });

  it('handles backspace beyond start of buffer without underflowing', () => {
    expect(canonicalizeInput('\b\b\bok')).toBe('ok');
  });
});

describe('canonicalizeOutput', () => {
  it('strips ANSI', () => {
    expect(canonicalizeOutput('\x1b[32mok\x1b[0m')).toBe('ok');
  });

  it('drops bare \\r but keeps \\r\\n', () => {
    expect(canonicalizeOutput('line1\rline2\r\nline3')).toBe('line1line2\r\nline3');
  });
});
