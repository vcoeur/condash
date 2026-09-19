import { createEffect, createSignal, type Accessor } from 'solid-js';
import type { OpenPullRequest, Project } from '@shared/types';
import { rendererPerf } from './perf-renderer';

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

/** Trailing-debounce window the production `createPrIndexSync` call site
 *  applies to reload triggers: rapid re-triggers (pane toggling, project
 *  add/remove churn) coalesce into one batch. Internal constant — not
 *  user-facing; passed explicitly so the visibility-gate tests can exercise
 *  the sync with the debounce off. */
export const PR_INDEX_DEBOUNCE_MS = 1_000;

/** Concurrent-lookup cap for one reload batch, mirroring the house
 *  `GIT_SLOT_LIMIT` magnitude. Deliberately its own resource: `gh` stays out
 *  of the git-slot pool (a slow network call must not hold a git slot), so
 *  the cap is applied inside the batch drain instead. */
const RELOAD_POOL_LIMIT = 6;

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
 * tokens of every project that declares a branch and fetches each repo's
 * open PRs through a bounded pool (at most `RELOAD_POOL_LIMIT` in flight,
 * tokens drained in insertion order), merging each result into the index as
 * it lands so badges populate progressively instead of in one swap. A
 * no-op-shaped empty set clears the index. Never throws — a failed repo
 * fetch just contributes no badges.
 *
 * @param projects The current project list (typically the store's accessor value).
 */
export async function reloadPrIndex(projects: readonly Project[]): Promise<void> {
  const span = rendererPerf.startSpan();
  try {
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
    const tokens = [...apps];
    const merged = new Map<string, OpenPullRequest[]>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < tokens.length) {
        // Superseded mid-drain: stop pulling new lookups. Ones already in
        // flight still settle (nothing cancels them) and are discarded
        // below — the generation guard stays per entry.
        if (mine !== generation) return;
        const app = tokens[next++];
        let prs: OpenPullRequest[] = [];
        try {
          prs = await window.condash.listOpenPullRequests(app);
        } catch {
          prs = [];
        }
        // A newer reload owns the index now — this entry must not land.
        if (mine !== generation) return;
        merged.set(app, prs);
        setPrIndex(new Map(merged));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(RELOAD_POOL_LIMIT, tokens.length) }, () => worker()),
    );
  } finally {
    rendererPerf.endSpan('prIndexReload', span);
  }
}

/**
 * Keep the badge index in sync with the project list, gated on the Projects
 * pane actually being visible — the badges render nowhere else, so a lookup
 * fired while the pane is hidden is pure `gh` fan-out against an invisible
 * surface (the perf corpus: p50 24 s per call, one per projects-list churn
 * event). The effect reads both signals: hiding the pane stops the fan-out
 * (the last-known index stays put, so re-showing paints instantly and then
 * refreshes), and showing it re-runs the effect, landing fresh badges.
 *
 * When `debounceMs` > 0 the triggers are additionally coalesced behind a
 * trailing debounce: every visible trigger (re)arms one timer, and a single
 * `reloadPrIndex` fires once the window quiets, reading the latest list at
 * fire time — outside the effect's tracking window, so the reactivity that
 * re-runs the effect stays on the `projects` accessor read in the body. A
 * hidden pane still arms nothing, and hiding drops a timer already armed.
 * The production call site passes `PR_INDEX_DEBOUNCE_MS`; the default keeps
 * the shipped fire-immediately behaviour.
 *
 * @param projects    The projects-store accessor.
 * @param paneVisible Accessor — true when the Projects pane is on screen.
 * @param debounceMs  Trailing-debounce window in ms; 0 fires immediately.
 */
export function createPrIndexSync(
  projects: Accessor<readonly Project[]>,
  paneVisible: Accessor<boolean>,
  debounceMs = 0,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const list = projects();
    if (!paneVisible()) {
      // The gate: a hidden pane arms nothing — and a timer armed before the
      // pane hid must not fire into the hidden pane either.
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      return;
    }
    if (debounceMs <= 0) {
      void reloadPrIndex(list);
      return;
    }
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reloadPrIndex(projects());
    }, debounceMs);
  });
}
