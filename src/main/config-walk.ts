import { basename, isAbsolute, join } from 'node:path';
import type { TerminalPrefs } from '../shared/types';
import { appHandle } from '../shared/app-color';
import { isSectionMarker, type RawRepo, type RawSubmoduleRepo } from '../shared/config-types';

/**
 * Shared configuration-walk helpers. Both `repos.ts` (for the flat repo list
 * the Code pane renders) and `terminals.ts` / `launchers.ts` (for the per-name
 * lookup the Run / force_stop pipelines need) walk the same `repositories`
 * tree. This module owns the recursion + cwd-resolution rules so the rest of
 * the main process doesn't re-implement them.
 *
 * The raw entry types and the section-marker discriminator are re-exported
 * from `shared/config-types` so existing `config-walk` importers keep working.
 */

export { isSectionMarker, type RawRepo, type RawSubmoduleRepo };

export interface ConfigShape {
  workspace_path?: string;
  repositories?: RawRepo[];
  terminal?: TerminalPrefs;
}

export interface RepoLookup {
  /** Display name (`parent/child` for submodules). */
  display: string;
  /** Bare directory name (no parent prefix) — `entry.name` or, when only a
   *  `path` is given, its basename. The on-disk identity worktree / run /
   *  force_stop machinery keys on. */
  name: string;
  /** Canonical `#handle` (no leading `#`) — the public identity. Explicit
   *  `entry.handle`, or `appHandle(name)` when unset. */
  handle: string;
  /** Legacy spellings that resolve to this handle, from `condash.json`. */
  aliases?: string[];
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

/**
 * Resolve an entry's absolute cwd. `explicitPath` (when set) takes the place of
 * `name` in path resolution; `name` then serves only as the display identifier.
 *
 * Resolution rules:
 *   - Absolute `explicitPath` / `name` → returned as-is.
 *   - Relative path under a `parent` (submodule) → `<workspace>/<parent>/<path>`
 *     i.e. the explicit path is interpreted relative to the parent directory,
 *     not to `workspace_path`.
 *   - Relative path with no parent → `<workspace>/<path>`.
 */
export function resolveCwd(
  workspace: string | undefined,
  parent: string | undefined,
  name: string,
  explicitPath?: string,
): string {
  const target = explicitPath ?? name;
  if (isAbsolute(target)) return target;
  const segments: string[] = [];
  if (workspace) segments.push(workspace);
  if (parent) segments.push(parent);
  segments.push(target);
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
      handle: appHandle(entry),
      parent,
      cwd: resolveCwd(workspace, parent, entry),
      section,
    };
    return visit(lookup) === false;
  }
  // Section markers are stripped by the caller. By construction this branch
  // only receives a repo-object variant.
  if ('section' in entry) return false;
  // The directory name is `name`, or the basename of `path` when only a path
  // is configured (the clean `{handle, label, path}` form). The handle is
  // explicit or derived from that directory name.
  const dirName = entry.name ?? basename(entry.path ?? '');
  const lookup: RepoLookup = {
    display: parent ? `${parent}/${dirName}` : dirName,
    name: dirName,
    handle: entry.handle ?? appHandle(dirName),
    aliases: entry.aliases,
    label: entry.label,
    parent,
    cwd: resolveCwd(workspace, parent, dirName, entry.path),
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

/**
 * Find a repo by its canonical handle (the `#`-stripped, lowercased token).
 * Used by the `applications` CLI and `apps:` validation, which resolve a
 * reference to its registered repo. Returns the first match in declaration
 * order, or null.
 */
export function findRepoByHandle(config: ConfigShape, handle: string): RepoLookup | null {
  const target = appHandle(handle);
  let found: RepoLookup | null = null;
  walkRepos(config, (entry) => {
    if (entry.handle === target) {
      found = entry;
      return false;
    }
  });
  return found;
}
