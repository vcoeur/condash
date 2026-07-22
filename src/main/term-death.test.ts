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

  it('does NOT call the tab OOM-killed when a child died but the shell exited itself', () => {
    // The cgroup OOM killer picks one victim from the whole tab. When it takes a
    // compiler or test runner, the shell survives, reports the failure, and exits
    // on its own — unsignalled. Labelling that "killed — out of memory" would
    // blame the tab for a death it reported rather than suffered.
    const death = deriveDeath({
      exitCode: 2,
      before: events(0, 10),
      after: events(1, 44),
    });
    expect(death.kind).toBe('failed');
    expect(death.label).toBe('exited — code 2');
    // The evidence still rides along for the log footer.
    expect(death.oomKillDelta).toBe(1);
  });

  it('ignores cgroup counters when the before-sample is missing', () => {
    // An unscoped tab, or one that died before its first periodic sample, has no
    // baseline. Falling back to `after > 0` would resurrect the cumulative trap.
    const death = deriveDeath({ exitCode: 0, signal: 9, after: events(1, 20) });
    expect(death.kind).toBe('killed');
    expect(death.oomKillDelta).toBeUndefined();
    expect(death.highDelta).toBeUndefined();
  });

  it('never blames memory for a stop condash itself issued', () => {
    // The kill pipeline ends in SIGKILL, and a tab resting near MemoryHigh has
    // `high` ticking under ordinary reclaim — verified live: a throttled tab
    // climbed 222 → 1055 on that counter while merely sitting there. Without
    // this guard, quitting the app with such a tab open writes a phantom
    // "killed — out of memory" into the log footer, corrupting the very
    // longitudinal record the verdicts exist to produce.
    const death = deriveDeath({
      exitCode: 0,
      signal: 9,
      before: events(0, 100),
      after: events(1, 900),
      intentional: true,
    });
    expect(death.kind).toBe('stopped');
    // The raw counters still ride along — the evidence is kept, only the OOM
    // *attribution* is withheld.
    expect(death.oomKillDelta).toBe(1);
    expect(death.highDelta).toBe(800);
  });

  it('still reports an OOM kill that lands during a stop, and keeps the row', () => {
    // The stop window is up to 3.5s wide (force_stop timeout + SIGKILL grace),
    // so a tab can genuinely trip its own MemoryMax inside it. `oom_kill` only
    // moves when the cgroup OOM killer fires, so the evidence is real whoever
    // asked for the stop — reporting a bare 'stopped' would auto-close the row
    // and lose the only report of it.
    const death = deriveDeath({
      exitCode: 0,
      signal: 9,
      before: events(0, 10),
      after: events(1, 12),
      intentional: true,
    });
    // NOT promoted to 'oom-cap': our own SIGKILL has destroyed the test that
    // separates "the shell was the victim" from "a child was, and the shell
    // survived" — promoting would blame the tab for a child's death.
    expect(death.kind).toBe('stopped');
    expect(death.label).toBe('stopped — out-of-memory kill in this tab');
    expect(isAbnormal(death)).toBe(true);
  });

  it('auto-closes an ordinary stop with no memory evidence', () => {
    const death = deriveDeath({
      exitCode: 0,
      signal: 9,
      before: events(0, 100),
      after: events(0, 900),
      intentional: true,
    });
    expect(death.label).toBe('stopped');
    // Throttling alone is not news — it is the ambient state of any tab near
    // its soft limit, which is the whole reason the intentional guard exists.
    expect(isAbnormal(death)).toBe(false);
  });

  it('will not attribute a death to counters whose window predates it', () => {
    // When the exit-time read loses its race with `--collect`, the caller can
    // only offer the last two periodic samples — a window closing up to one
    // sampling interval BEFORE the death, which therefore cannot contain the
    // oom_kill the kernel writes at the moment of death. Reporting `oom-cap`
    // from it would assert a tier-2 guess with tier-1 confidence.
    const death = deriveDeath({
      exitCode: 0,
      signal: 9,
      before: events(0, 10),
      after: events(1, 50),
      bracketsDeath: false,
    });
    expect(death.kind).toBe('killed');
    expect(death.label).toBe('killed — SIGKILL');
    // Evidence preserved for the footer even though it did not promote a verdict.
    expect(death.oomKillDelta).toBe(1);
  });

  it('attributes normally when the window does bracket the death', () => {
    // The complement of the above, and the normal path: measured against live
    // systemd, the exit-time read wins its race with `--collect` — the cgroup is
    // still readable at onExit and gone ~50 ms later.
    const death = deriveDeath({
      exitCode: 0,
      signal: 9,
      before: events(0, 10),
      after: events(1, 50),
      bracketsDeath: true,
    });
    expect(death.kind).toBe('oom-cap');
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
