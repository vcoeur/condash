import { createSignal } from 'solid-js';
import type { OpenPullRequest, Project } from '@shared/types';

// Shared open-PR index behind the Projects-pane card badges.
//
// The batch design (see main/pr-lookup.ts): one `gh pr list` per repo, not one
// per card. This module fetches the open PRs for every repo referenced by the
// branch-bearing projects (keyed by the `apps:` token, resolved server-side),
// holds them in a module-scoped reactive signal, and exposes a pure matcher so
// each card can look up its own branch for free — no per-card IPC. Module
// scope mirrors the `overStatus` drag signal in projects-parts/cards.tsx: a
// cross-cutting card concern read directly by the leaf, not threaded as a prop
// through GroupBlock / SubGroup / Card.

/** app token → that repo's open PRs. Empty until the first reload resolves. */
const [prIndex, setPrIndex] = createSignal<Map<string, OpenPullRequest[]>>(new Map());

// Monotonic generation guard: a slow reload must not overwrite a newer one
// (e.g. a conception switch or a rapid project-list churn mid-fetch).
let generation = 0;

/**
 * Match a project to its open PR(s): for each of the project's `apps`, find
 * the open PRs in that repo whose head branch equals the project's `branch`.
 * Deduped by PR number. Empty when the project has no branch, no apps, or no
 * matching open PR. Pure; exported for tests.
 *
 * @param index  app token → that repo's open PRs.
 * @param project The project (only `apps` + `branch` are read).
 * @returns The project's open PRs, most-relevant repo first, deduped.
 */
export function matchProjectPrs(
  index: ReadonlyMap<string, OpenPullRequest[]>,
  project: Pick<Project, 'apps' | 'branch'>,
): OpenPullRequest[] {
  const branch = project.branch;
  if (!branch) return [];
  const out: OpenPullRequest[] = [];
  const seen = new Set<number>();
  for (const app of project.apps) {
    for (const pr of index.get(app) ?? []) {
      if (pr.headRefName !== branch) continue;
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      out.push(pr);
    }
  }
  return out;
}

/** Reactive read of the current index — a card badge re-renders when a reload
 *  lands new PRs. Returns the project's open PR(s), or an empty array. */
export function prsForProject(project: Pick<Project, 'apps' | 'branch'>): OpenPullRequest[] {
  return matchProjectPrs(prIndex(), project);
}

/**
 * Refresh the index for the given projects. Collects the distinct `apps:`
 * tokens of every project that declares a branch, fetches each repo's open PRs
 * in parallel, and swaps in the new index. A no-op-shaped empty set clears the
 * index. Never throws — a failed repo fetch just contributes no badges.
 *
 * @param projects The current project list (typically the store's accessor value).
 */
export async function reloadPrIndex(projects: readonly Project[]): Promise<void> {
  const apps = new Set<string>();
  for (const project of projects) {
    if (!project.branch) continue;
    for (const app of project.apps) apps.add(app);
  }
  const mine = ++generation;
  if (apps.size === 0) {
    setPrIndex(new Map());
    return;
  }
  const entries = await Promise.all(
    [...apps].map(async (app): Promise<[string, OpenPullRequest[]]> => {
      try {
        return [app, await window.condash.listOpenPullRequests(app)];
      } catch {
        return [app, []];
      }
    }),
  );
  // Drop a stale result: a newer reload (or a conception switch) started while
  // this one's `gh` calls were in flight.
  if (mine !== generation) return;
  setPrIndex(new Map(entries));
}
