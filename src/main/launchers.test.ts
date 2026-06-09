/**
 * Unit tests for `tokenise` — the hand-rolled argv splitter feeding
 * `spawn(..., { shell: false })` for open-with launchers and force_stop
 * commands. Documents the contract: quote-aware splitting, `{path}`
 * substitution at the arg level, leading-tilde expansion, and NO backslash
 * escaping (this is argv splitting, not a shell).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tokenise } from './launchers';

describe('tokenise — basic splitting', () => {
  it('splits on spaces and tabs, collapsing runs of whitespace', () => {
    expect(tokenise('code --wait', '/p')).toEqual(['code', '--wait']);
    expect(tokenise('code   --wait\t--new-window', '/p')).toEqual([
      'code',
      '--wait',
      '--new-window',
    ]);
  });

  it('returns [] for empty or whitespace-only commands', () => {
    expect(tokenise('', '/p')).toEqual([]);
    expect(tokenise('   \t ', '/p')).toEqual([]);
  });
});

describe('tokenise — quoting', () => {
  it('keeps quoted whitespace inside one token (double and single quotes)', () => {
    expect(tokenise('cmd "a b" c', '')).toEqual(['cmd', 'a b', 'c']);
    expect(tokenise("cmd 'a b'", '')).toEqual(['cmd', 'a b']);
  });

  it('joins adjacent quoted and bare segments into one token', () => {
    expect(tokenise('cmd pre"mid dle"post', '')).toEqual(['cmd', 'premid dlepost']);
    expect(tokenise(`cmd "a"'b'`, '')).toEqual(['cmd', 'ab']);
  });

  it('keeps an explicitly quoted empty string as an empty argv entry', () => {
    expect(tokenise('cmd "" tail', '')).toEqual(['cmd', '', 'tail']);
    expect(tokenise("cmd ''", '')).toEqual(['cmd', '']);
  });

  it('treats the other quote kind as a literal inside quotes', () => {
    expect(tokenise(`cmd "don't"`, '')).toEqual(['cmd', "don't"]);
    expect(tokenise(`cmd 'say "hi"'`, '')).toEqual(['cmd', 'say "hi"']);
  });

  it('an unterminated quote consumes to end of input', () => {
    expect(tokenise('cmd "a b', '')).toEqual(['cmd', 'a b']);
  });

  it('passes backslashes through literally (no escape processing)', () => {
    expect(tokenise('cmd a\\b', '')).toEqual(['cmd', 'a\\b']);
    expect(tokenise('cmd a\\ b', '')).toEqual(['cmd', 'a\\', 'b']);
  });
});

describe('tokenise — {path} substitution', () => {
  it('substitutes after splitting, so a path with spaces stays one token', () => {
    expect(tokenise('idea {path}', '/my path/repo')).toEqual(['idea', '/my path/repo']);
    expect(tokenise('idea "{path}"', '/my path/repo')).toEqual(['idea', '/my path/repo']);
  });

  it('substitutes every occurrence, including mid-token', () => {
    expect(tokenise('cmd --root={path} {path}/sub', '/r')).toEqual(['cmd', '--root=/r', '/r/sub']);
  });
});

describe('tokenise — tilde expansion', () => {
  it('expands a leading ~/ to the home directory', () => {
    expect(tokenise('~/bin/foo {path}', '/x')).toEqual([join(homedir(), 'bin/foo'), '/x']);
  });

  it('expands a bare ~ token', () => {
    expect(tokenise('ls ~', '')).toEqual(['ls', homedir()]);
  });

  it('leaves a mid-token tilde alone', () => {
    expect(tokenise('cmd a~b', '')).toEqual(['cmd', 'a~b']);
  });
});
