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
// Monotonic version of the needle set: bumped once per *successful* rebuild.
// The scan growth-gates each tab on its byte count, which is the right gate for
// verdict churn but wrong across a needle change — a tab that printed a
// brand-new project's slug and then went silent (the `condash projects create`
// case) would never be re-scored once the new needle existed, because its
// `bytesSeen` stopped advancing before the set caught up. Comparing versions
// lets the scan re-score every tab exactly when recognition changes and not
// otherwise. A failed rebuild keeps the old set, so it bumps nothing.
let version = 0;
// Bumped by every invalidation. A rebuild reads the tree over hundreds of
// milliseconds, so a README written mid-build is not in the result; comparing
// this counter across the build tells the rebuild whether it may clear
// staleness or must leave the next scan to try again. Without it that write is
// dropped for good — the search index carries the same guard, for the same
// reason (`search/index-cache.ts`, its buildToken / buildBuffer pair).
let invalidations = 0;

/**
 * Mark the needle set stale. Called from the watcher on any project README
 * change — a create, a status flip to `done`, or a branch edit all change what
 * the scan should recognise.
 */
export function invalidateMentionNeedles(): void {
  invalidations += 1;
  stale = true;
}

/** Drop the set entirely (conception switch / teardown). */
export function clearMentionNeedles(): void {
  cached = null;
  invalidations += 1;
  stale = true;
}

async function rebuild(conceptionPath: string): Promise<void> {
  const startedAt = invalidations;
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
  // Only settle when nothing invalidated while this build was reading: a change
  // that landed mid-build is not in `needles`, and clearing staleness here would
  // strand it until the tree happened to change again.
  if (invalidations === startedAt) {
    stale = false;
    version += 1;
  }
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

/**
 * Monotonic version of the needle set — bumps on every successful rebuild, so a
 * consumer that last scanned at an older version knows recognition changed and
 * must re-examine text it already scored. Version 0 means "no set has ever
 * completed building".
 *
 * @returns The current needle-set version.
 */
export function mentionNeedlesVersion(): number {
  return version;
}
