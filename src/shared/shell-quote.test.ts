import { describe, expect, it } from 'vitest';
import {
  posixSingleQuote,
  quoteForShell,
  shellCommandArgv,
  shellFamily,
  type ShellFamily,
} from './shell-quote';

describe('shellFamily', () => {
  it('detects cmd.exe by basename, case-insensitively', () => {
    expect(shellFamily('cmd.exe', true)).toBe('cmd');
    expect(shellFamily('cmd', true)).toBe('cmd');
    expect(shellFamily('C:\\Windows\\System32\\cmd.exe', true)).toBe('cmd');
    expect(shellFamily('C:\\Windows\\System32\\CMD.EXE', true)).toBe('cmd');
  });

  it('detects PowerShell variants regardless of platform', () => {
    expect(shellFamily('powershell.exe', true)).toBe('powershell');
    expect(shellFamily('pwsh.exe', true)).toBe('powershell');
    expect(shellFamily('/usr/bin/pwsh', false)).toBe('powershell');
    expect(shellFamily('powershell', true)).toBe('powershell');
  });

  it('treats every other shell as POSIX (incl. Git-for-Windows bash)', () => {
    expect(shellFamily('/bin/bash', false)).toBe('posix');
    expect(shellFamily('/usr/bin/zsh', false)).toBe('posix');
    expect(shellFamily('C:\\Program Files\\Git\\bin\\bash.exe', true)).toBe('posix');
  });

  it('falls back to the platform default when no shell is configured', () => {
    expect(shellFamily(undefined, false)).toBe('posix');
    expect(shellFamily('', false)).toBe('posix');
    expect(shellFamily('  ', false)).toBe('posix');
    expect(shellFamily(undefined, true)).toBe('cmd');
  });
});

describe('shellCommandArgv', () => {
  it('builds the per-family argv shapes', () => {
    expect(shellCommandArgv('posix', 'echo hi')).toEqual(['-c', 'echo hi']);
    expect(shellCommandArgv('cmd', 'echo hi')).toEqual(['/d', '/s', '/c', 'echo hi']);
    expect(shellCommandArgv('powershell', 'echo hi')).toEqual([
      '-NoLogo',
      '-NonInteractive',
      '-Command',
      'echo hi',
    ]);
  });
});

describe('quoteForShell — quoting matrix', () => {
  const QUOTES = `it's a "quoted" thing`;
  const AMP_PIPE = 'a & b | c';
  const PERCENT = 'progress 100% of %PATH%';
  const NEWLINES = 'line one\nline two';

  describe('posix', () => {
    it('single-quotes and escapes embedded single quotes', () => {
      expect(quoteForShell(QUOTES, 'posix')).toBe(`'it'\\''s a "quoted" thing'`);
    });

    it('keeps &, |, %VAR%, and $ inert inside single quotes', () => {
      expect(quoteForShell(AMP_PIPE, 'posix')).toBe(`'a & b | c'`);
      expect(quoteForShell(PERCENT, 'posix')).toBe(`'progress 100% of %PATH%'`);
      expect(quoteForShell('$HOME', 'posix')).toBe(`'$HOME'`);
    });

    it('preserves newlines verbatim', () => {
      expect(quoteForShell(NEWLINES, 'posix')).toBe(`'line one\nline two'`);
    });

    it('posixSingleQuote is the same transform', () => {
      expect(posixSingleQuote(QUOTES)).toBe(quoteForShell(QUOTES, 'posix'));
    });
  });

  describe('powershell', () => {
    it('single-quotes and doubles embedded single quotes', () => {
      expect(quoteForShell(QUOTES, 'powershell')).toBe(`'it''s a "quoted" thing'`);
    });

    it('keeps &, |, %, and $ inert inside the literal string', () => {
      expect(quoteForShell(AMP_PIPE, 'powershell')).toBe(`'a & b | c'`);
      expect(quoteForShell(PERCENT, 'powershell')).toBe(`'progress 100% of %PATH%'`);
      expect(quoteForShell('$env:PATH', 'powershell')).toBe(`'$env:PATH'`);
    });

    it('preserves newlines verbatim', () => {
      expect(quoteForShell(NEWLINES, 'powershell')).toBe(`'line one\nline two'`);
    });
  });

  describe('cmd', () => {
    it('C-runtime-quotes embedded double quotes, then caret-escapes them for cmd', () => {
      expect(quoteForShell('say "hi"', 'cmd')).toBe('^"say \\^"hi\\^"^"');
    });

    it('caret-escapes & and | so cmd never treats them as operators', () => {
      expect(quoteForShell(AMP_PIPE, 'cmd')).toBe('^"a ^& b ^| c^"');
    });

    it('caret-escapes % so %VAR% never expands', () => {
      // `%PATH^%` names no variable, so expansion leaves the text alone and
      // caret removal restores the literal `%PATH%` for the child.
      expect(quoteForShell(PERCENT, 'cmd')).toBe('^"progress 100^% of ^%PATH^%^"');
    });

    it('folds newlines to spaces (cmd cannot carry a literal newline)', () => {
      expect(quoteForShell(NEWLINES, 'cmd')).toBe('^"line one line two^"');
      expect(quoteForShell('a\r\nb', 'cmd')).toBe('^"a b^"');
    });

    it('doubles a trailing backslash run so it cannot eat the closing quote', () => {
      expect(quoteForShell('dir C:\\', 'cmd')).toBe('^"dir C:\\\\^"');
    });

    it('caret-escapes redirects and grouping metacharacters', () => {
      expect(quoteForShell('a < b > c (d) !e ^f', 'cmd')).toBe('^"a ^< b ^> c ^(d^) ^!e ^^f^"');
    });
  });

  it('the dangerous-prompt example is inert under every family', () => {
    const hostile = `pwn'; rm -rf ~ & del /q * | %TEMP%`;
    const families: ShellFamily[] = ['posix', 'cmd', 'powershell'];
    for (const family of families) {
      const quoted = quoteForShell(hostile, family);
      // Whatever the family, the quoted form must start inside a quote
      // context — never with a bare metacharacter.
      expect(quoted.startsWith("'") || quoted.startsWith('^"')).toBe(true);
    }
  });
});
