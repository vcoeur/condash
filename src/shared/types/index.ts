// Thin barrel for the shared type contract. The 74 exports were split out of a
// single ~988-line `types.ts` into domain modules; this barrel re-exports them
// all so every existing `@shared/types` (and `../shared/types`) import keeps
// resolving unchanged. Reach for the specific domain module when adding new
// types; import from the barrel when you want several domains at once.
//
// Domains:
//   common      — cross-cutting primitives (Platform, ItemKind, HelpDocName, Theme)
//   project     — project lifecycle (statuses, steps, deliverables, Project, create/transition)
//   layout      — renderer view-state (WorkingSurface, LeftView, LayoutState)
//   settings    — persisted settings + per-pane prefs + open-with slots
//   git         — git/worktree status + repo entries + repo events
//   terminal    — terminal sessions, prefs, agents, spawn/data/exit messages
//   logs        — terminal-log session browsing
//   task-runs   — task scheduling + run tracking (runtime side of tasks)
//   search      — global search query/hit/result shapes
//   tree        — Knowledge/Resources/Skills tree nodes + events + init probe

export * from './common';
export * from './project';
export * from './layout';
export * from './settings';
export * from './git';
export * from './terminal';
export * from './logs';
export * from './task-runs';
export * from './search';
export * from './tree';
