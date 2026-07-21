/**
 * Why a terminal session ended.
 *
 * Until this module existed, an OOM-killed tab and a clean `exit 0` were
 * byte-identical everywhere condash looked: `pty.onExit` captured only the exit
 * code, node-pty's `signal` was discarded, and nothing read the tab cgroup's
 * `memory.events`. Field evidence (three kills over 30 days, every one logged
 * `"exitCode":0`) showed the failure rate was unmeasurable as a result.
 *
 * The derivation is pure and lives off the Electron/node-pty boundary so it is
 * unit-testable in the node vitest env — the same split `prompt-decorations.ts`
 * and `terminal-flow.ts` use.
 *
 * ## Why cgroup deltas, not absolute counters
 *
 * cgroup v2's `memory.events` counters are **cumulative for the life of the
 * cgroup**. A tab throttled once an hour ago reports `high > 0` forever, so
 * testing `high > 0` at exit would label every later SIGKILL — however
 * unrelated — a memory-pressure kill. The caller therefore passes the counters
 * sampled at the *previous* periodic sample as `before`, and only a genuine
 * increase counts as evidence.
 */

import type { TermDeath } from '../shared/types';

import type { CgroupMemoryEvents } from './tab-scope';

/** True when the verdict is anything other than a clean `exit 0`. Drives whether
 *  the tab row is kept on screen instead of auto-closing. */
export function isAbnormal(death: TermDeath): boolean {
  return death.kind !== 'clean';
}

/** POSIX signal numbers condash names explicitly; anything else renders as its
 *  raw number, which is more useful than a wrong guess. */
const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  6: 'SIGABRT',
  9: 'SIGKILL',
  13: 'SIGPIPE',
  15: 'SIGTERM',
};

/** `SIGKILL`-style name for a signal number, falling back to `signal N`. */
export function signalName(signal: number): string {
  return SIGNAL_NAMES[signal] ?? `signal ${signal}`;
}

const SIGKILL = 9;

/** Inputs to a verdict — everything known at the moment a pty exits. */
export interface DeathEvidence {
  /** node-pty's reported exit status. */
  exitCode: number;
  /** node-pty's reported terminating signal. node-pty reports `0` (not
   *  undefined) for a process that exited normally, so both are treated as
   *  "not signalled". */
  signal?: number;
  /** cgroup `memory.events` sampled at the previous periodic tick, or undefined
   *  for an unscoped tab / a host without cgroup v2. */
  before?: CgroupMemoryEvents;
  /** cgroup `memory.events` sampled at exit, before the scope is reaped. */
  after?: CgroupMemoryEvents;
}

/**
 * Classify how a session ended.
 *
 * Ordering matters: the cgroup's own OOM kill is checked before the external
 * one, because a cap hit also raises `high` on the way up — so testing pressure
 * first would mislabel every cap hit.
 *
 * Both OOM verdicts require the shell itself to have been signalled. The cgroup
 * OOM killer picks one victim from the whole tab — often a child (a compiler, a
 * test runner), leaving the shell alive to report the failure and exit on its
 * own. That tab was not killed, so it does not get a "killed" label; the raw
 * `oomKillDelta` still rides along on the verdict for the log footer.
 *
 * @param evidence Exit status, signal, and the cgroup counters bracketing the death.
 * @returns The verdict, carrying both the classification and its evidence.
 */
export function deriveDeath(evidence: DeathEvidence): TermDeath {
  const { exitCode, before, after } = evidence;
  // node-pty reports 0 for "not signalled"; normalise both spellings.
  const signal = evidence.signal === 0 ? undefined : evidence.signal;

  // A delta needs both ends. Without a `before` sample (an unscoped tab, or a
  // tab that died before its first periodic sample) the counters are unusable
  // as evidence — deliberately not falling back to `after > 0`, which is the
  // cumulative-counter trap this module exists to avoid.
  const delta = (pick: (e: CgroupMemoryEvents) => number): number | undefined =>
    before && after ? Math.max(0, pick(after) - pick(before)) : undefined;

  const oomKillDelta = delta((e) => e.oomKill);
  const highDelta = delta((e) => e.high);

  const base = { exitCode, signal, oomKillDelta, highDelta };

  if (signal === SIGKILL && oomKillDelta !== undefined && oomKillDelta > 0) {
    return { ...base, kind: 'oom-cap', label: 'killed — out of memory (cap)' };
  }
  if (signal === SIGKILL && highDelta !== undefined && highDelta > 0) {
    return {
      ...base,
      kind: 'oom-pressure',
      label: 'killed — out of memory (system pressure)',
    };
  }
  if (signal === SIGKILL) {
    return { ...base, kind: 'killed', label: 'killed — SIGKILL' };
  }
  if (signal !== undefined) {
    return { ...base, kind: 'signal', label: `terminated — ${signalName(signal)}` };
  }
  if (exitCode !== 0) {
    return { ...base, kind: 'failed', label: `exited — code ${exitCode}` };
  }
  return { ...base, kind: 'clean', label: 'exited' };
}
