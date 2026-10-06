import type { Project, TreeEvent } from '@shared/types';
import type { ProjectsOwnership } from './projects-store';
import { rendererPerf } from './perf-renderer';

/**
 * Per-channel callbacks for the renderer. The watcher emits typed
 * `TreeEvent`s (`'project' | 'knowledge' | 'resources' | 'skills' |
 * 'config' | 'unknown'`); this module dispatches each kind to the
 * matching reloader so an edit in one pane doesn't refetch the others.
 */
export interface TreeEventsDeps {
  /** Ownership for per-project patches, shared with the projects store.
   *  `registerBatch` runs synchronously before this dispatcher's first
   *  `await`, so every operation in the received batch — including unlink
   *  tombstones and membership invalidations — owns its path before any
   *  held lookup can apply. */
  projectOwnership: ProjectsOwnership;
  /** Path-shaped patch to the projects list. Used for `'project'`
   *  unlink events — one card moves; the rest don't blink. */
  mutateProjects: (next: (items: Project[]) => Project[]) => void;
  /** Full reload of the projects list. Called only as part of the
   *  `'unknown'` fan-out (last-resort backstop). */
  reloadProjects: () => Promise<void>;
  /** Reload knowledge / resources / skills trees. Each one fires only
   *  when its kind appears in the batch (or on the unknown backstop). */
  reloadKnowledge: () => Promise<void>;
  reloadResources: () => Promise<void>;
  reloadSkills: () => Promise<void>;
  /** Re-read condash.json-backed bits the renderer caches: Open With
   *  slots and per-conception terminal prefs. Fires on `'config'`
   *  events. */
  reloadConfig: () => Promise<void>;
  /** Re-fetch repos. Repo events flow through `repo-events` for
   *  scalar / structural updates; the `'config'` path is for repo-list
   *  add / remove (which only `config` events surface to the renderer). */
  refetchRepos: () => void;
}

/**
 * Apply a batch of chokidar-driven tree events. Per-project events
 * patch in place via the shared projects ownership; pane-level events
 * fire the matching `reload*` exactly once even when multiple events of
 * the same kind appear in the batch. The watcher coalesces bursts into a
 * single batch (250 ms debounce); we coalesce within the batch.
 */
export async function applyTreeEvents(events: TreeEvent[], deps: TreeEventsDeps): Promise<void> {
  const span = rendererPerf.startSpan();
  try {
    await dispatchTreeEvents(events, deps);
  } finally {
    rendererPerf.endSpan('treeApplyEvents', span);
  }
}

async function dispatchTreeEvents(events: TreeEvent[], deps: TreeEventsDeps): Promise<void> {
  // Registration pass — strictly before the first await, so a held
  // `getProject` reply for an early event can never apply over a later
  // operation in the same batch (a deletion must never be resurrected by
  // a lookup that started before the deletion was seen).
  const tickets = deps.projectOwnership.registerBatch(events);

  let knowledgeDirty = false;
  let resourcesDirty = false;
  let skillsDirty = false;
  let configDirty = false;
  let projectsDirty = false;
  let unknownSeen = false;

  for (const event of events) {
    if (event.kind === 'unknown') {
      // Unknown events trigger the full fan-out below — but keep
      // iterating so per-project patches earlier in the batch still
      // apply. A single unknown in the middle of a burst would
      // otherwise drop every later event and the UI would flash back
      // to pre-event state until the reload resolves.
      unknownSeen = true;
      continue;
    }
    if (event.kind === 'ignore') {
      // Store-irrelevant (index regen etc.). The watcher already drops these
      // before notifying; guarded here so a stray one is a no-op, not a crash.
      continue;
    }
    if (event.kind === 'projects-reload') {
      // Project-tree structure changed (dir add/remove, bulk checkout): reload
      // only the project list — none of the other panes (R1).
      projectsDirty = true;
      continue;
    }
    if (event.kind === 'config') {
      configDirty = true;
      continue;
    }
    if (event.kind === 'knowledge') {
      knowledgeDirty = true;
      continue;
    }
    if (event.kind === 'resources') {
      resourcesDirty = true;
      continue;
    }
    if (event.kind === 'skills') {
      skillsDirty = true;
      continue;
    }
    // Per-project patch (`event.kind === 'project'`).
    if (event.op === 'unlink') {
      deps.mutateProjects((items) => items.filter((p) => p.path !== event.path));
      continue;
    }
    // Only the batch's final operation per path gets a ticket; a superseded
    // event is skipped without issuing a lookup at all.
    const ticket = tickets.get(event);
    if (!ticket) continue;
    try {
      const project = await window.condash.getProject(event.path);
      if (!project) {
        deps.projectOwnership.settle(ticket, (items) => items.filter((p) => p.path !== event.path));
        continue;
      }
      // `getProject` returns the full project (with `timeline[]`); the resident
      // list keeps timelines out (G1 — matches the `listProjects` projection),
      // so patch with a timeline-stripped copy. The card reads `lastActivity`.
      const row = project.timeline.length === 0 ? project : { ...project, timeline: [] };
      deps.projectOwnership.settle(ticket, (items) => {
        const idx = items.findIndex((p) => p.path === row.path);
        if (idx === -1) return [...items, row];
        const next = items.slice();
        next[idx] = row;
        return next;
      });
    } catch {
      deps.projectOwnership.fail(ticket);
      unknownSeen = true;
    }
  }

  if (unknownSeen) {
    // Backstop — same shape as the pre-split fan-out, just routed
    // through per-channel reloaders. Includes repos because an unknown
    // event could be anything (repo file changes outside the watched
    // roots, etc.).
    await Promise.all([
      deps.reloadProjects(),
      deps.reloadKnowledge(),
      deps.reloadResources(),
      deps.reloadSkills(),
      deps.reloadConfig(),
    ]);
    deps.refetchRepos();
    return;
  }

  const tasks: Promise<unknown>[] = [];
  if (projectsDirty) tasks.push(deps.reloadProjects());
  if (knowledgeDirty) tasks.push(deps.reloadKnowledge());
  // A `condash.json` edit can change settings the trees indirectly depend
  // on (the resources/skills paths themselves are hard-coded since the
  // reframe). The watcher rebuilds its watch set on a `config` event, but
  // the in-memory trees still need an explicit reload.
  if (resourcesDirty || configDirty) tasks.push(deps.reloadResources());
  if (skillsDirty || configDirty) tasks.push(deps.reloadSkills());
  if (configDirty) {
    tasks.push(deps.reloadConfig());
    // Repos can be added / removed only via a config edit — repo-events
    // handles everything else.
    deps.refetchRepos();
  }
  if (tasks.length) await Promise.all(tasks);
}
