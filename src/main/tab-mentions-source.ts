/**
 * The needle set behind {@link ../main/tab-mentions | tab-mentions}, cached.
 *
 * Split from the scorer so that module stays pure and unit-testable with plain
 * fixtures. This half is the impure one: it walks the conception's project tree
 * and reads the effective config.
 *
 * The set is built lazily and then held until something in the tree changes.
 * Rebuilding is not cheap — `findProjectReadmes` probes every item directory
 * (~330-390 ms on a large tree, per its own review note) — so it must never ride
 * the scan tick. The watcher calls {@link invalidateMentionNeedles} when a
 * README changes, which is the only thing that can alter a slug, a status or a
 * branch; the next scan then rebuilds off the tick, and scans in the meantime
 * use the previous set rather than blocking or dropping to nothing.
 */

import { getEffectiveConceptionConfig } from './effective-config';
import { parseReadmeCached } from './parse-cache';
import { buildNeedles } from './tab-mentions';
import { findProjectReadmes } from './walk';

type Needles = ReturnType<typeof buildNeedles>;

let cached: { conceptionPath: string; needles: Needles } | null = null;
let stale = true;
let building: Promise<void> | null = null;

/**
 * Mark the needle set stale. Called from the watcher on any project README
 * change — a create, a status flip to `done`, or a branch edit all change what
 * the scan should recognise.
 */
export function invalidateMentionNeedles(): void {
  stale = true;
}

/** Drop the set entirely (conception switch / teardown). */
export function clearMentionNeedles(): void {
  cached = null;
  stale = true;
}

async function rebuild(conceptionPath: string): Promise<void> {
  const readmes = await findProjectReadmes(conceptionPath);
  // `parseReadmeCached` memoises on path + mtime, so a rebuild after a one-file
  // edit re-parses that one file and stats the rest.
  const projects = await Promise.all(
    readmes.map((readme) => parseReadmeCached(readme).catch(() => null)),
  );
  let longLived: string[] = [];
  try {
    longLived = (await getEffectiveConceptionConfig(conceptionPath)).long_lived_branches ?? [];
  } catch {
    // No readable config — every branch needle stays in. A branch like `main`
    // then contributes its weight-1 needle, which the dominance rule is there
    // to absorb; failing the whole scan over a config read would be worse.
  }
  cached = {
    conceptionPath,
    needles: buildNeedles(
      projects.filter((project): project is NonNullable<typeof project> => project !== null),
      longLived,
    ),
  };
  stale = false;
}

/**
 * The current needle set, kicking a rebuild when stale.
 *
 * Never blocks: a stale set is returned as-is while the rebuild runs, and the
 * next scan picks up the fresh one. A suggestion is advisory, so serving one
 * tick from a set that is a few hundred milliseconds old costs nothing, whereas
 * awaiting a tree walk on the timer thread would stall the memory sampler this
 * rides on.
 *
 * @param conceptionPath The active conception, or null when none is set.
 * @returns The needles to scan with; empty until the first build completes.
 */
export function mentionNeedles(conceptionPath: string | null): Needles {
  if (!conceptionPath) {
    if (cached) clearMentionNeedles();
    return [];
  }
  const fresh = cached?.conceptionPath === conceptionPath;
  if ((!fresh || stale) && !building) {
    building = rebuild(conceptionPath)
      .catch(() => {
        // Tree unreadable this pass — keep whatever set we had and retry on the
        // next scan rather than clearing to "recognise nothing".
      })
      .finally(() => {
        building = null;
      });
  }
  return fresh ? cached!.needles : [];
}
