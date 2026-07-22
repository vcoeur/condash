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

/** Re-export of the shared predicate. It lives in `shared/` because the renderer
 *  needs the same answer to decide whether to draw the verdict badge and the
 *  Restart button — two independent copies had already drifted once. */
export { isAbnormalDeath as isAbnormal } from '../shared/term-death-shape';

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
  /** True when `after` was read at exit and therefore the `before`→`after`
   *  window actually contains the death. False when the exit-time read lost its
   *  race with `--collect` and the caller substituted the last two periodic
   *  samples — a window that closes *before* the death and so cannot contain
   *  the event it would be used to attribute. See {@link deriveDeath}. */
  bracketsDeath?: boolean;
  /** True when condash itself terminated the session — a user Stop, a tab close,
   *  or the app quitting. The kill pipeline ends in SIGKILL, which is otherwise
   *  indistinguishable from an external kill. */
  intentional?: boolean;
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
 * Two further guards keep the record honest, because this verdict is persisted
 * to the session log footer and is the longitudinal evidence the whole feature
 * exists to produce — a false entry is worse than a missing one:
 *
 * - **An intentional stop is never an OOM verdict.** condash's own kill pipeline
 *   ends in SIGKILL, and a tab resting near `MemoryHigh` has `high` ticking
 *   under ordinary reclaim. Without this, quitting the app with a memory-active
 *   tab open manufactures a "killed — out of memory" record for a deliberate
 *   shutdown.
 * - **Counters that do not bracket the death cannot attribute it.** When the
 *   exit-time read loses its race with `--collect`, the caller can only offer
 *   the last two periodic samples — a window closing up to one sampling interval
 *   *before* the death, which therefore cannot contain the `oom_kill` written at
 *   the moment of death. Such counters still ride along for the footer, but they
 *   do not promote a verdict.
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

  // A stop condash issued itself is not a diagnosis. Reported before any signal
  // branch: the pipeline's own SIGKILL is exactly what would otherwise be read
  // as an external kill.
  //
  // But it must not swallow the evidence either. The stop window is up to 3.5 s
  // wide (force_stop timeout plus the SIGKILL grace), and a tab can genuinely
  // trip its own MemoryMax inside it. `oom_kill` only moves when the cgroup OOM
  // killer fires, so a positive delta is real regardless of who asked for the
  // stop, and reporting a bare "stopped" would auto-close the row and lose it.
  //
  // The verdict stays `stopped` rather than `oom-cap` because our own SIGKILL
  // has destroyed the test that separates the two: normally `signal === SIGKILL`
  // is what shows the *shell* was the victim rather than a child (a compiler, a
  // test runner) that the killer picked while the shell survived. During a stop
  // that signal may be ours, so promoting to `oom-cap` would blame the tab for a
  // child's death — the exact false positive the SIGKILL requirement was added
  // to prevent. Report both facts and let the reader judge.
  if (evidence.intentional === true) {
    const sawOomKill = oomKillDelta !== undefined && oomKillDelta > 0;
    return {
      ...base,
      kind: 'stopped',
      label: sawOomKill ? 'stopped — out-of-memory kill in this tab' : 'stopped',
    };
  }

  // Counters only attribute a death if their window contains it. `bracketsDeath`
  // defaults to true so a caller that supplies a genuine exit-time reading needs
  // no ceremony; only the degraded fallback has to say so.
  const attributable = evidence.bracketsDeath !== false;

  if (attributable && signal === SIGKILL && oomKillDelta !== undefined && oomKillDelta > 0) {
    return { ...base, kind: 'oom-cap', label: 'killed — out of memory (cap)' };
  }
  if (attributable && signal === SIGKILL && highDelta !== undefined && highDelta > 0) {
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
