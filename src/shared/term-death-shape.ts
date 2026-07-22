/**
 * Predicates over a {@link TermDeath} that BOTH processes need.
 *
 * Main decides whether to keep a dead row and ships an `abnormal` flag with the
 * exit event; the renderer decides whether to draw the verdict badge and the
 * Restart button. Those two answers must agree, and when they were written
 * independently they did not: the renderer tested `kind !== 'clean'`, so adding
 * the `stopped` kind made every ordinary Stop render an empty warn-coloured pill
 * and a Restart button for the moment before the row auto-closed.
 *
 * Living in `shared/` is the fix — one definition, imported by both sides.
 */
import type { TermDeath } from './types';

/**
 * Whether a death warrants keeping the tab row on screen instead of auto-closing.
 *
 * A clean `exit 0` does not, and neither does a stop condash itself issued — the
 * user who pressed Stop does not need the outcome explained back to them, and
 * pinning that row would defeat the close.
 *
 * The exception is a stop that *also* saw the cgroup OOM killer fire: the user
 * asked for the close, but "something in this tab ran out of memory" is news
 * they did not have, and auto-closing would discard the only report of it.
 *
 * @param death The verdict derived at exit.
 * @returns True when the row should be kept and the verdict shown.
 */
export function isAbnormalDeath(death: TermDeath): boolean {
  if (death.kind === 'clean') return false;
  if (death.kind === 'stopped') return (death.oomKillDelta ?? 0) > 0;
  return true;
}
