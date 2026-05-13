import { isAbsolute, join } from 'node:path';

/**
 * Shared configuration-walk helpers. Both `repos.ts` (for the flat repo list
 * the Code pane renders) and `terminals.ts` / `launchers.ts` (for the per-name
 * lookup the Run / force_stop pipelines need) walk the same `repositories`
 * tree. This module owns the recursion + cwd-resolution rules so the rest of
 * the main process doesn't re-implement them.
 */

export type RawSubmoduleRepo =
  | string
  | {
      name: string;
      label?: string;
      run?: string;
      force_stop?: string;
    };

export type RawRepo =
  | string
  | {
      name: string;
      label?: string;
      run?: string;
      force_stop?: string;
      submodules?: RawSubmoduleRepo[];
    }
  | { section: string };

export interface ConfigShape {
  workspace_path?: string;
  repositories?: RawRepo[];
}

/** True when `entry` is a section-marker variant of `RawRepo`. */
export function isSectionMarker(entry: RawRepo): entry is { section: string } {
  return typeof entry === 'object' && entry !== null && 'section' in entry;
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
  /** Name of the most-recent `{ section: … }` marker that preceded this
   *  entry in `repositories[]`, when any. Undefined for entries before the
   *  first marker — those belong to the implicit default bucket. Submodule
   *  entries inherit their parent's section. */
  section?: string;
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
 * Walk every repo entry in `config.repositories` (recursing into `submodules`)
 * in declaration order. Visitors that want to short-circuit the walk return
 * `false`; returning `true` (or `void`) keeps the walk going.
 */
export function walkRepos(config: ConfigShape, visit: (entry: RepoLookup) => boolean | void): void {
  const workspace = config.workspace_path;
  if (!config.repositories) return;
  let currentSection: string | undefined;
  for (const entry of config.repositories) {
    if (isSectionMarker(entry)) {
      currentSection = entry.section;
      continue;
    }
    if (visitOne(entry, undefined, workspace, currentSection, visit)) return;
  }
}

function visitOne(
  entry: RawRepo | RawSubmoduleRepo,
  parent: string | undefined,
  workspace: string | undefined,
  section: string | undefined,
  visit: (entry: RepoLookup) => boolean | void,
): boolean {
  if (typeof entry === 'string') {
    const lookup: RepoLookup = {
      display: parent ? `${parent}/${entry}` : entry,
      name: entry,
      parent,
      cwd: resolveCwd(workspace, parent, entry),
      section,
    };
    return visit(lookup) === false;
  }
  // Section markers are stripped by the caller. By construction this branch
  // only receives a repo-object variant.
  if ('section' in entry) return false;
  const lookup: RepoLookup = {
    display: parent ? `${parent}/${entry.name}` : entry.name,
    name: entry.name,
    label: entry.label,
    parent,
    cwd: resolveCwd(workspace, parent, entry.name),
    run: entry.run,
    forceStop: entry.force_stop,
    section,
  };
  if (visit(lookup) === false) return true;
  if ('submodules' in entry && entry.submodules?.length) {
    for (const sub of entry.submodules) {
      if (visitOne(sub, entry.name, workspace, section, visit)) return true;
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
