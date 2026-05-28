import type { Project, TreeEvent } from '@shared/types';

/**
 * Per-channel callbacks for the renderer. The watcher emits typed
 * `TreeEvent`s (`'project' | 'knowledge' | 'resources' | 'skills' |
 * 'config' | 'unknown'`); this module dispatches each kind to the
 * matching reloader so an edit in one pane doesn't refetch the others.
 */
export interface TreeEventsDeps {
  /** Path-shaped patch to the projects list. Used for `'project'`
   *  events — one card moves; the rest don't blink. */
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
 * patch in place via `mutateProjects`; pane-level events fire the
 * matching `reload*` exactly once even when multiple events of the
 * same kind appear in the batch. The watcher coalesces bursts into a
 * single batch (250 ms debounce); we coalesce within the batch.
 */
export async function applyTreeEvents(events: TreeEvent[], deps: TreeEventsDeps): Promise<void> {
  let knowledgeDirty = false;
  let resourcesDirty = false;
  let skillsDirty = false;
  let configDirty = false;
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
    try {
      if (event.op === 'unlink') {
        deps.mutateProjects((items) => items.filter((p) => p.path !== event.path));
        continue;
      }
      const project = await window.condash.getProject(event.path);
      if (!project) {
        deps.mutateProjects((items) => items.filter((p) => p.path !== event.path));
        continue;
      }
      deps.mutateProjects((items) => {
        const idx = items.findIndex((p) => p.path === project.path);
        if (idx === -1) return [...items, project];
        const next = items.slice();
        next[idx] = project;
        return next;
      });
    } catch {
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
