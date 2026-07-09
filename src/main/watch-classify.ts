// Pure classification of chokidar FS events into renderer `TreeEvent`s.
//
// Split out of watcher.ts (which pulls in electron + chokidar and so can't load
// under the node vitest env) so the classifier — the R1-critical hot path that
// decides how much of the dashboard reloads on each edit — is unit-tested
// directly.
//
// The guiding rule: an ordinary in-tree edit must reload as little as possible.
// Only a genuinely unrecognised path falls to `unknown`, which fires the full
// whole-dashboard fan-out. In-project files (notes, local/, …) patch one card;
// index regens are ignored; project dir add/remove reloads only the project
// list.

import { join } from 'node:path';
import { toPosix } from '../shared/path';
import { conceptionConfigCandidates } from './condash-dir';
import type { TreeEvent } from '../shared/types';

export type ChokidarEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

export interface RootSet {
  resources: string;
  skills: string;
}

/** Constant paths computed once per conception so the hot path is string
 *  compares, not repeated `join + toPosix`. */
export interface WatchPaths {
  conceptionP: string;
  /** The three conception-config candidates (POSIX), from the single
   *  `conceptionConfigCandidates` list — a `config` event matches any of them. */
  configCandidates: string[];
  agentsRoot: string;
  claudeRoot: string;
  claudeDot: string;
  projectsPrefix: string;
  knowledgePrefix: string;
}

export function buildWatchPaths(conception: string): WatchPaths {
  const conceptionP = toPosix(conception);
  return {
    conceptionP,
    configCandidates: conceptionConfigCandidates(conception).map(toPosix),
    agentsRoot: toPosix(join(conception, 'AGENTS.md')),
    claudeRoot: toPosix(join(conception, 'CLAUDE.md')),
    claudeDot: toPosix(join(conception, '.claude', 'CLAUDE.md')),
    projectsPrefix: `${conceptionP}/projects/`,
    knowledgePrefix: `${conceptionP}/knowledge/`,
  };
}

function chokidarToOp(eventName: ChokidarEvent): 'add' | 'change' | 'unlink' | null {
  if (eventName === 'add') return 'add';
  if (eventName === 'change') return 'change';
  if (eventName === 'unlink') return 'unlink';
  return null;
}

/**
 * Classify one chokidar event into a `TreeEvent` telling the renderer how much
 * to reload. See the module header for the guiding rule.
 */
export function classify(
  eventName: ChokidarEvent,
  path: string,
  roots: RootSet,
  paths: WatchPaths,
): TreeEvent {
  // Chokidar can emit native or POSIX separators; compare on a POSIX view so
  // prefix/suffix checks behave the same on macOS, Linux, and Windows.
  const pathP = toPosix(path);
  const projectsRoot = paths.projectsPrefix.slice(0, -1); // strip trailing '/'

  // Directory add/remove — route to the one scoped reload for whichever tree
  // the dir sits under, never the whole-dashboard + repo-sweep fan-out.
  //   projects/  — a project create/delete, a `notes/` dir appearing, or a bulk
  //                git checkout → reload only the project list (R1).
  //   knowledge/ or resources/ — a `mkdir knowledge/topics/x` / a new resources
  //                subdir → reload only that tree, not ~20 git spawns (B3). The
  //                renderer reloads the whole tree for these kinds, so op/path
  //                don't affect the outcome, but the TreeEvent shape carries them.
  // A dir event anywhere else stays the true catch-all.
  if (eventName === 'addDir' || eventName === 'unlinkDir') {
    if (pathP === projectsRoot || pathP.startsWith(paths.projectsPrefix)) {
      return { kind: 'projects-reload' };
    }
    const dirOp = eventName === 'addDir' ? 'add' : 'unlink';
    const knowledgeRoot = paths.knowledgePrefix.slice(0, -1); // strip trailing '/'
    if (pathP === knowledgeRoot || pathP.startsWith(paths.knowledgePrefix)) {
      return { kind: 'knowledge', op: dirOp, path };
    }
    if (pathP === roots.resources || pathP.startsWith(`${roots.resources}/`)) {
      return { kind: 'resources', op: dirOp, path };
    }
    return { kind: 'unknown' };
  }

  const op = chokidarToOp(eventName);
  if (!op) return { kind: 'unknown' };

  // Config files: canonical `.condash/settings.json` + two legacy names.
  if (paths.configCandidates.includes(pathP)) {
    return { kind: 'config', path };
  }

  // Conception-level AGENTS.md (canonical) / legacy CLAUDE.md → Skills pane
  // pinned callout.
  if (pathP === paths.agentsRoot || pathP === paths.claudeRoot || pathP === paths.claudeDot) {
    return { kind: 'skills', op, path };
  }

  // Anything under projects/.
  if (pathP.startsWith(paths.projectsPrefix)) {
    const parts = pathP.slice(paths.projectsPrefix.length).split('/');
    // <month>/<slug>/README.md → the card itself (insert / update / remove).
    if (parts.length === 3 && parts[2] === 'README.md') {
      return { kind: 'project', op, path };
    }
    // <month>/<slug>/<anything-else> — a note, a local/ file, a nested README.
    // Patch that one card: its README is unchanged so getProject is a
    // parse-cache hit and the reconcile is a no-op, but crucially we skip the
    // whole-dashboard reload. Always `change`, never a removal — the README
    // still exists; only an in-project file moved.
    if (parts.length >= 3) {
      return {
        kind: 'project',
        op: 'change',
        path: `${paths.projectsPrefix}${parts[0]}/${parts[1]}/README.md`,
      };
    }
    // projects/index.md or projects/<month>/index.md (and any other file above
    // the slug level): regen / structural noise the renderer's stores never
    // read. Ignore — the search index is kept fresh independently upstream.
    return { kind: 'ignore' };
  }

  // Knowledge: any `.md` under knowledge/.
  if (pathP.startsWith(paths.knowledgePrefix) && pathP.toLowerCase().endsWith('.md')) {
    return { kind: 'knowledge', op, path };
  }

  // Resources: every file under the configured resources root.
  if (pathP === roots.resources || pathP.startsWith(`${roots.resources}/`)) {
    return { kind: 'resources', op, path };
  }

  // Skills: every `.md` file under the configured skills root (or any unlink).
  if (
    (pathP === roots.skills || pathP.startsWith(`${roots.skills}/`)) &&
    (pathP.toLowerCase().endsWith('.md') || op === 'unlink')
  ) {
    return { kind: 'skills', op, path };
  }

  return { kind: 'unknown' };
}
