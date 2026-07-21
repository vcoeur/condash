import { describe, expect, it } from 'vitest';

import { deriveDeath, isAbnormal, signalName } from './term-death';
import type { CgroupMemoryEvents } from './tab-scope';

const events = (oomKill: number, high: number, max = 0): CgroupMemoryEvents => ({
  oomKill,
  high,
  max,
});

describe('deriveDeath', () => {
  it('classifies a clean exit', () => {
    const death = deriveDeath({ exitCode: 0 });
    expect(death.kind).toBe('clean');
    expect(death.label).toBe('exited');
    expect(isAbnormal(death)).toBe(false);
  });

  it('classifies a non-zero exit', () => {
    const death = deriveDeath({ exitCode: 127 });
    expect(death.kind).toBe('failed');
    expect(death.label).toBe('exited — code 127');
    expect(isAbnormal(death)).toBe(true);
  });

  it('treats node-pty signal 0 as "not signalled"', () => {
    // node-pty reports 0 rather than undefined for a normal exit; both spellings
    // must classify identically or every clean exit reads as a signal death.
    expect(deriveDeath({ exitCode: 0, signal: 0 }).kind).toBe('clean');
    expect(deriveDeath({ exitCode: 3, signal: 0 }).kind).toBe('failed');
  });

  it('classifies a non-KILL signal', () => {
    const death = deriveDeath({ exitCode: 0, signal: 15 });
    expect(death.kind).toBe('signal');
    expect(death.label).toBe('terminated — SIGTERM');
  });

  it('classifies a bare SIGKILL with no cgroup evidence', () => {
    const death = deriveDeath({ exitCode: 0, signal: 9 });
    expect(death.kind).toBe('killed');
    expect(death.label).toBe('killed — SIGKILL');
  });

  it('classifies a cgroup cap hit from an oom_kill increase', () => {
    const death = deriveDeath({
      exitCode: 0,
      signal: 9,
      before: events(0, 4),
      after: events(1, 9),
    });
    expect(death.kind).toBe('oom-cap');
    expect(death.label).toBe('killed — out of memory (cap)');
    expect(death.oomKillDelta).toBe(1);
  });

  it('classifies an external pressure kill from a high increase without oom_kill', () => {
    // The field case: systemd-oomd kills the scope on PSI pressure while the
    // cgroup is throttling at MemoryHigh. The cgroup's own OOM killer never
    // fires, so oom_kill stays flat.
    const death = deriveDeath({
      exitCode: 0,
      signal: 9,
      before: events(0, 2),
      after: events(0, 57),
    });
    expect(death.kind).toBe('oom-pressure');
    expect(death.label).toBe('killed — out of memory (system pressure)');
    expect(death.highDelta).toBe(55);
  });

  it('prefers the cap verdict when both counters moved', () => {
    // A cap hit also drives reclaim on the way up, so `high` rises too. Checking
    // pressure first would mislabel every cap hit.
    const death = deriveDeath({
      exitCode: 0,
      signal: 9,
      before: events(0, 0),
      after: events(1, 40),
    });
    expect(death.kind).toBe('oom-cap');
  });

  it('does NOT treat a stale cumulative high count as pressure evidence', () => {
    // The trap this module exists to avoid: `memory.events` counters are
    // cumulative for the cgroup's life. A tab throttled an hour ago still reports
    // high > 0 at exit. Only an increase across the death is evidence.
    const death = deriveDeath({
      exitCode: 0,
      signal: 9,
      before: events(0, 88),
      after: events(0, 88),
    });
    expect(death.kind).toBe('killed');
    expect(death.highDelta).toBe(0);
  });

  it('ignores cgroup counters when the before-sample is missing', () => {
    // An unscoped tab, or one that died before its first periodic sample, has no
    // baseline. Falling back to `after > 0` would resurrect the cumulative trap.
    const death = deriveDeath({ exitCode: 0, signal: 9, after: events(1, 20) });
    expect(death.kind).toBe('killed');
    expect(death.oomKillDelta).toBeUndefined();
    expect(death.highDelta).toBeUndefined();
  });

  it('clamps a counter that went backwards to zero', () => {
    // Defensive: a reused/recreated cgroup path could read lower than the prior
    // sample. A negative delta must not read as evidence.
    const death = deriveDeath({
      exitCode: 0,
      signal: 9,
      before: events(3, 30),
      after: events(0, 0),
    });
    expect(death.kind).toBe('killed');
    expect(death.oomKillDelta).toBe(0);
    expect(death.highDelta).toBe(0);
  });

  it('carries the raw evidence on every verdict', () => {
    const death = deriveDeath({
      exitCode: 137,
      signal: 9,
      before: events(0, 1),
      after: events(0, 3),
    });
    expect(death.exitCode).toBe(137);
    expect(death.signal).toBe(9);
    expect(death.oomKillDelta).toBe(0);
    expect(death.highDelta).toBe(2);
  });
});

describe('signalName', () => {
  it('names the signals condash reports', () => {
    expect(signalName(9)).toBe('SIGKILL');
    expect(signalName(15)).toBe('SIGTERM');
  });

  it('falls back to the raw number rather than guessing', () => {
    expect(signalName(31)).toBe('signal 31');
  });
});
