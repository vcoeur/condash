/**
 * Worktree mutators (setup / remove) and a per-branch state inspector.
 *
 * Both mutators are multi-app aware: the canonical input is a branch name,
 * the union of `**Apps**` across items declaring that branch defines which
 * repos get a worktree. Pinned repos (those carrying `pinned_branch:` in
 * `condash.json`) are excluded from setup since they track a different
 * axis. Removal is protected-set aware: repos still claimed by *other* active
 * items on the same branch keep their worktree.
 *
 * The mutators do not delete local branches — that stays in skill prose
 * because the safety-net is "interactive `git branch -d` refuse must surface
 * to the user". Removal of the *worktree* is in scope; removal of the local
 * branch is not.
 *
 * The implementation is split across `worktree/inspect.ts`,
 * `worktree/setup.ts`, `worktree/remove.ts`, and `worktree/shared.ts`. This
 * file is the public barrel — every existing import path stays stable.
 */

export type { BranchCheckResult, BranchRepoState } from './worktree/inspect';
export { checkBranchState } from './worktree/inspect';

export type { SetupOptions, SetupResult } from './worktree/setup';
export { setupBranchWorktrees } from './worktree/setup';

export type { RemoveOptions, RemoveResult } from './worktree/remove';
export { removeBranchWorktrees } from './worktree/remove';
