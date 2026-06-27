/**
 * Unit tests for the pure helpers in `terminals.ts` — the cross-OS shell
 * wrapping (`wrapForShell` / `defaultShell`) and the rolling-buffer cap
 * (`appendRecentTail` / `recentTail`, the F10 hysteresis). The live pty path is
 * deliberately out of scope: `electron` and `node-pty` are mocked so importing
 * the module doesn't pull in the native / Electron runtime, and only the pure
 * functions are exercised.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('node-pty', () => ({ spawn: () => ({}) }));

import { appendRecentTail, defaultShell, recentTail, wrapForShell } from './terminals';

/** Mirror of the module-internal cap + hysteresis so the assertions can pin the
 *  exact thresholds the readers depend on. */
const MAX_BUFFER = 64_000;
const BUFFER_SLACK = 16_000;

describe('wrapForShell', () => {
  // The test host is POSIX, so the win32-only fallback branch never fires; the
  // family is picked purely from the shell basename, which is platform-free.
  it('wraps a POSIX shell with -c', () => {
    expect(wrapForShell('/bin/bash', 'echo hi')).toEqual(['-c', 'echo hi']);
    expect(wrapForShell('/usr/bin/zsh', 'ls -la')).toEqual(['-c', 'ls -la']);
  });

  it('wraps PowerShell with -NoLogo -NonInteractive -Command', () => {
    expect(wrapForShell('pwsh', 'Get-ChildItem')).toEqual([
      '-NoLogo',
      '-NonInteractive',
      '-Command',
      'Get-ChildItem',
    ]);
  });

  it('wraps cmd.exe with /d /s /c', () => {
    expect(wrapForShell('cmd.exe', 'dir')).toEqual(['/d', '/s', '/c', 'dir']);
  });
});

describe('defaultShell', () => {
  const savedShell = process.env.SHELL;

  afterEach(() => {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  });

  it('returns the configured shell verbatim when non-blank', () => {
    expect(defaultShell('/usr/bin/fish')).toBe('/usr/bin/fish');
  });

  it('falls through a blank/whitespace configured value to $SHELL on POSIX', () => {
    process.env.SHELL = '/bin/zsh';
    expect(defaultShell('')).toBe('/bin/zsh');
    expect(defaultShell('   ')).toBe('/bin/zsh');
    expect(defaultShell(undefined)).toBe('/bin/zsh');
  });

  it('falls back to /bin/bash on POSIX when $SHELL is unset', () => {
    delete process.env.SHELL;
    expect(defaultShell(undefined)).toBe('/bin/bash');
  });
});

describe('appendRecentTail / recentTail — F10 rolling-buffer cap', () => {
  it('appends without reslicing while under MAX_BUFFER + BUFFER_SLACK', () => {
    expect(appendRecentTail('', 'abc')).toBe('abc');
    // A tail well under the reslice threshold is allowed to grow past
    // MAX_BUFFER — proof the hot path does NOT reslice on every chunk.
    const tail = 'a'.repeat(MAX_BUFFER + 5_000);
    const grown = appendRecentTail(tail, 'b');
    expect(grown.length).toBe(MAX_BUFFER + 5_001);
    expect(grown).toBe(tail + 'b');
  });

  it('reslices to the last MAX_BUFFER chars once the overrun exceeds the slack', () => {
    const tail = 'a'.repeat(MAX_BUFFER + BUFFER_SLACK);
    const trimmed = appendRecentTail(tail, 'b');
    expect(trimmed.length).toBe(MAX_BUFFER);
    expect(trimmed).toBe((tail + 'b').slice(-MAX_BUFFER));
    expect(trimmed.endsWith('b')).toBe(true);
  });

  it('recentTail exposes only the last MAX_BUFFER chars', () => {
    expect(recentTail('short')).toBe('short');
    const over = 'x'.repeat(MAX_BUFFER + 100);
    expect(recentTail(over).length).toBe(MAX_BUFFER);
    expect(recentTail(over)).toBe(over.slice(-MAX_BUFFER));
  });

  it('reader output is byte-identical to a naive per-chunk cap over a stream', () => {
    // Feed many chunks through the hysteresis append and confirm the reader's
    // view always equals the old "(buffer + data).slice(-MAX_BUFFER)" each step.
    let viaHelper = '';
    let naive = '';
    for (let i = 0; i < 400; i++) {
      const chunk = String.fromCharCode(65 + (i % 26)).repeat(500);
      viaHelper = appendRecentTail(viaHelper, chunk);
      naive = (naive + chunk).slice(-MAX_BUFFER);
      expect(recentTail(viaHelper)).toBe(naive);
    }
    // The total stream (200_000 chars) far exceeds the cap, so the final tail
    // is exactly MAX_BUFFER.
    expect(recentTail(viaHelper).length).toBe(MAX_BUFFER);
  });
});
