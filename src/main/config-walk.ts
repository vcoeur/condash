import { isAbsolute, join } from 'node:path';

/**
 * Shared configuration-walk helpers. Both `repos.ts` (for the flat repo list
 * the Code tab renders) and `terminals.ts` / `launchers.ts` (for the per-name
 * lookup the Run / force_stop pipelines need) walk the same `repositories`
 * tree. This module owns the recursion + cwd-resolution rules so the rest of
 * the main process doesn't re-implement them.
 */

export type RawRepo =
  | string
  | {
      name: string;
      label?: string;
      run?: string;
      force_stop?: string;
      submodules?: RawRepo[];
    };

export interface ConfigShape {
  workspace_path?: string;
  repositories?: {
    primary?: RawRepo[];
    secondary?: RawRepo[];
  };
}

export interface RepoLookup {
  /** Display name (`parent/child` for submodules). */
  display: string;
  /** Bare entry name (no parent prefix). */
  name: string;
  /** Optional human-friendly label. Surfaced as a card subtitle when set. */
  label?: string;
  /** Parent name when this entry is a submodule. */
  parent?: string;
  /** Resolved absolute cwd. */
  cwd: string;
  /** Configured run: command, if any. */
  run?: string;
  /** Configured force_stop: command, if any. */
  forceStop?: string;
}

/** Resolve an entry's absolute cwd from `workspace_path` + optional parent + name. */
export function resolveCwd(
  workspace: string | undefined,
  parent: string | undefined,
  name: string,
): string {
  if (isAbsolute(name)) return name;
  const segments: string[] = [];
  if (workspace) segments.push(workspace);
  if (parent) segments.push(parent);
  segments.push(name);
  return segments.length === 1 ? segments[0] : join(...segments);
}

/**
 * Walk every repo entry in `config.repositories` (primary + secondary,
 * recursing into `submodules`). The visitor receives a fully-resolved
 * `RepoLookup` and a `kind` discriminator. Visitors that want to short-circuit
 * the walk return `false`; returning `true` (or `void`) keeps the walk going.
 */
export function walkRepos(
  config: ConfigShape,
  visit: (entry: RepoLookup, kind: 'primary' | 'secondary') => boolean | void,
): void {
  const workspace = config.workspace_path;
  const visitList = (entries: RawRepo[], kind: 'primary' | 'secondary'): boolean => {
    for (const entry of entries) {
      const stop = visitOne(entry, kind, undefined, workspace, visit);
      if (stop) return true;
    }
    return false;
  };
  if (config.repositories?.primary) {
    if (visitList(config.repositories.primary, 'primary')) return;
  }
  if (config.repositories?.secondary) {
    visitList(config.repositories.secondary, 'secondary');
  }
}

function visitOne(
  entry: RawRepo,
  kind: 'primary' | 'secondary',
  parent: string | undefined,
  workspace: string | undefined,
  visit: (entry: RepoLookup, kind: 'primary' | 'secondary') => boolean | void,
): boolean {
  if (typeof entry === 'string') {
    const lookup: RepoLookup = {
      display: parent ? `${parent}/${entry}` : entry,
      name: entry,
      parent,
      cwd: resolveCwd(workspace, parent, entry),
    };
    return visit(lookup, kind) === false;
  }
  const lookup: RepoLookup = {
    display: parent ? `${parent}/${entry.name}` : entry.name,
    name: entry.name,
    label: entry.label,
    parent,
    cwd: resolveCwd(workspace, parent, entry.name),
    run: entry.run,
    forceStop: entry.force_stop,
  };
  if (visit(lookup, kind) === false) return true;
  if (entry.submodules?.length) {
    for (const sub of entry.submodules) {
      if (visitOne(sub, kind, entry.name, workspace, visit)) return true;
    }
  }
  return false;
}

/**
 * Find a single repo entry by name. Matches both the bare name and the
 * `parent/child` display form so callers don't have to know which one came
 * from the renderer.
 *
 * When the search is a bare name (e.g. `foo`) and the config contains both a
 * top-level repo `foo` and a sibling submodule `alpha/foo`, the top-level
 * entry wins. Reaching the submodule requires the qualified `alpha/foo` form.
 * Match priority:
 *   1. `entry.display === name`         — exact, including qualified
 *   2. `entry.name === name && !parent` — bare name on a top-level entry
 *   3. `entry.name === name && parent`  — bare name on a submodule (last)
 */
export function findRepoEntry(config: ConfigShape, name: string): RepoLookup | null {
  let topLevelByName: RepoLookup | null = null;
  let submoduleByName: RepoLookup | null = null;
  let exactByDisplay: RepoLookup | null = null;
  walkRepos(config, (entry) => {
    if (entry.display === name) {
      exactByDisplay = entry;
      return false; // best possible match — stop the walk
    }
    if (entry.name === name) {
      if (!entry.parent && !topLevelByName) topLevelByName = entry;
      else if (entry.parent && !submoduleByName) submoduleByName = entry;
    }
  });
  return exactByDisplay ?? topLevelByName ?? submoduleByName;
}
