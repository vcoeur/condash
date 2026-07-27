// Bounded gate for the read-only git lookups behind the Code pane's repo scan.
//
// `listRepos` fans out across every registry entry, and each entry's chain
// issues its own `git worktree list` / `git status` / `rev-parse` / `rev-list`.
// On a 29-entry registry that reached ~90 `git` spawns issued back-to-back and
// blocked the main event loop for ~4 s in one uninterrupted stretch (#475).
// The cost is the *spawn*, not git's runtime — an individual `git status` in
// those repos measures 6-23 ms, while forking a ~450 MB Electron main process
// is substantial kernel work that scales with the parent's RSS.
//
// The gate caps how many of those lookups are in flight, so the fork cost is
// spread across event-loop turns instead of landing in one. Spawn count is
// reduced separately (the `.git` stat fast path in `isGitRepo`, the reuse of
// the already-computed worktree list in `repos.ts`); the cap is what keeps the
// cost proportional to registry size instead of hitting the loop all at once,
// so it stays correct as a conception grows.
//
// Deliberately scoped to the status-read path rather than to `exec` itself:
// `exec` also carries `git fetch` / `git push` (sync), `gh` (pr-lookup), and
// the per-repo `install:` command of worktree setup. Letting one slow network
// call hold a slot would starve the pane this exists to unblock.

/** Max read-only git lookups in flight. Sits in the 4-8 range #475 argues for:
 *  low enough that a release wave is a handful of forks rather than a burst,
 *  high enough to keep several 6-23 ms lookups overlapping. */
export const GIT_SLOT_LIMIT = 6;

let inFlight = 0;
/** FIFO of callers parked waiting for a slot. A finishing caller hands its
 *  slot straight to the head of this queue rather than releasing it, so no
 *  arriving caller can slip into the gap and overshoot the limit. */
const waiting: Array<() => void> = [];

/**
 * Run one read-only git lookup under the shared concurrency cap.
 *
 * Wrap the subprocess-spawning call only — never a stretch that itself awaits
 * another gated call, which would hold a slot while queueing for one.
 *
 * @param run the lookup to perform once a slot is free
 * @returns whatever `run` resolves to; rejections propagate unchanged
 */
export async function withGitSlot<T>(run: () => Promise<T>): Promise<T> {
  if (inFlight >= GIT_SLOT_LIMIT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    inFlight++;
  }
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}
