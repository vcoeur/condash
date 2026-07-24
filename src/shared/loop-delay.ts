/**
 * The one definition of "event-loop delay" both processes report.
 *
 * A periodic sampler measures the gap between its own firings, not the excess
 * over the gap it asked for, so a raw reading has a floor equal to its interval
 * — `monitorEventLoopDelay` at `resolution: 10` reads p50 ≈ 10.1 ms on a
 * completely idle process. Reporting that raw once put a fixed ~10 ms (61 % of a
 * frame budget) on condash's headline "main loop p99" for an idle app: the
 * symptom under investigation, at a plausible magnitude, from an instrument
 * positioned to confirm its own hypothesis.
 *
 * Main subtracts its histogram's resolution; the renderer subtracts its probe's
 * interval. Both are this function. It lives in `shared/` because the two sides'
 * numbers are meant to be compared directly, and two copies of the arithmetic
 * are two things free to drift — the renderer's first copy already differed, by
 * dropping non-positive samples instead of flooring them, which biased its
 * median above main's.
 */

/**
 * Delay above the interval the sampler promised to fire at.
 *
 * @param elapsedMs Observed gap between two firings, in milliseconds.
 * @param intervalMs The interval the sampler was armed with.
 * @returns Milliseconds of delay in excess of `intervalMs`, floored at 0 and
 *   rounded to microsecond precision. A reading below the interval is not
 *   negative delay — it is unresolvable, and reads as 0.
 */
export function delayAboveInterval(elapsedMs: number, intervalMs: number): number {
  return Math.max(0, Math.round((elapsedMs - intervalMs) * 1e3) / 1e3);
}

/**
 * Loop-delay floor below which a window with no other activity is not worth
 * recording, in milliseconds.
 *
 * Main applies it when deciding whether to write a record at all; the renderer
 * applies it when deciding whether its drain is worth sending. Shared because
 * the two decisions compose: if the renderer sent every window, main's gate
 * could never fire and an idle app would write a record every 2.5 s for ever —
 * which is precisely what happened when each side owned its own rule.
 *
 * 5 ms is well under a 16.7 ms frame budget, so nothing perceptible is dropped.
 */
export const IDLE_LOOP_MAX_MS = 5;
