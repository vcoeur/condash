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

import {
  appendRecentTail,
  defaultShell,
  liveTabInfo,
  MEM_BROADCAST_QUANTUM_BYTES,
  memSampleChanged,
  rateChanged,
  RATE_BROADCAST_QUANTUM_BYTES_PER_SEC,
  recentTail,
  wrapForShell,
} from './terminals';
import type { TermSide } from '../shared/types';

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

describe('liveTabInfo — roster side/exit filtering (#366)', () => {
  /** A minimal session-like row for the mapper, overridable per case. */
  const row = (over: {
    id: string;
    side: TermSide;
    exited?: number;
    repo?: string;
    cmd?: string;
  }) => ({
    cwd: `/w/${over.id}`,
    ...over,
  });

  const entries = [
    row({ id: 'my-live', side: 'my', cmd: 'claude' }),
    row({ id: 'my-exited', side: 'my', exited: 0 }),
    row({ id: 'code-dev', side: 'code', repo: 'app', cmd: 'make dev' }),
    row({ id: 'code-exited', side: 'code', exited: 1 }),
  ];

  it('excludes exited sessions on both sides', () => {
    expect(liveTabInfo(entries).map((t) => t.sid)).toEqual(['my-live', 'code-dev']);
  });

  it("with side 'my', keeps only live terminal tabs (drops code-side dev servers)", () => {
    expect(liveTabInfo(entries, 'my').map((t) => t.sid)).toEqual(['my-live']);
  });

  it("with side 'code', keeps only live code-side sessions", () => {
    expect(liveTabInfo(entries, 'code').map((t) => t.sid)).toEqual(['code-dev']);
  });

  it('maps repo/cmd only when present', () => {
    const [tab] = liveTabInfo([row({ id: 'a', side: 'my' })]);
    expect(tab).toEqual({ sid: 'a', cwd: '/w/a' });
    const [withMeta] = liveTabInfo([row({ id: 'b', side: 'code', repo: 'r', cmd: 'c' })], 'code');
    expect(withMeta).toEqual({ sid: 'b', cwd: '/w/b', repo: 'r', cmd: 'c' });
  });
});

describe('memSampleChanged — T5 memory-broadcast quantization', () => {
  it('reports the first reading (undefined → number) as changed', () => {
    expect(memSampleChanged(undefined, 1_000_000)).toBe(true);
  });

  it('reports a transition to "no reading" (number → undefined) as changed', () => {
    expect(memSampleChanged(1_000_000, undefined)).toBe(true);
  });

  it('treats both-undefined and byte-identical readings as unchanged', () => {
    expect(memSampleChanged(undefined, undefined)).toBe(false);
    expect(memSampleChanged(5_000_000, 5_000_000)).toBe(false);
  });

  it('suppresses a sub-quantum wiggle (the steady-state idle churn)', () => {
    const base = 6_400_000_000; // ~6.4 GB, near a typical 80%-of-8GB warn line
    expect(memSampleChanged(base, base + 1)).toBe(false);
    expect(memSampleChanged(base, base + (MEM_BROADCAST_QUANTUM_BYTES - 1))).toBe(false);
    expect(memSampleChanged(base, base - (MEM_BROADCAST_QUANTUM_BYTES - 1))).toBe(false);
  });

  it('broadcasts a move of at least one quantum, in either direction', () => {
    const base = 6_400_000_000;
    expect(memSampleChanged(base, base + MEM_BROADCAST_QUANTUM_BYTES)).toBe(true);
    expect(memSampleChanged(base, base - MEM_BROADCAST_QUANTUM_BYTES)).toBe(true);
    expect(memSampleChanged(base, base + MEM_BROADCAST_QUANTUM_BYTES * 4)).toBe(true);
  });
});

describe('rateChanged — growth-rate broadcast quantization', () => {
  // The growth rate is a fresh integer on virtually every sample of a live
  // process, so an exact compare would set `changed` on every 2.5 s tick and
  // rebroadcast the whole session snapshot — undoing the T5 fix above for every
  // user running with memory scoping (the default), including those who never
  // open the perf pane. The rate needs its own quantum for the same reason
  // memBytes does.
  it('reports the first reading and a transition to "no reading" as changed', () => {
    expect(rateChanged(undefined, 4_000_000)).toBe(true);
    expect(rateChanged(4_000_000, undefined)).toBe(true);
  });

  it('treats both-undefined and identical rates as unchanged', () => {
    expect(rateChanged(undefined, undefined)).toBe(false);
    expect(rateChanged(2_000_000, 2_000_000)).toBe(false);
  });

  it('suppresses the sub-MB/s wobble a live process produces every tick', () => {
    const base = 12_000_000; // ~12 MB/s
    expect(rateChanged(base, base + 1)).toBe(false);
    expect(rateChanged(base, base + (RATE_BROADCAST_QUANTUM_BYTES_PER_SEC - 1))).toBe(false);
    expect(rateChanged(base, base - (RATE_BROADCAST_QUANTUM_BYTES_PER_SEC - 1))).toBe(false);
  });

  it('broadcasts a move of at least one quantum, in either direction', () => {
    const base = 12_000_000;
    expect(rateChanged(base, base + RATE_BROADCAST_QUANTUM_BYTES_PER_SEC)).toBe(true);
    expect(rateChanged(base, base - RATE_BROADCAST_QUANTUM_BYTES_PER_SEC)).toBe(true);
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
