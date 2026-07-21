import { ipcMain } from 'electron';
import { promises as fsp } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseHeader } from '../../shared/header';
import { compareByStatusThenSlug } from '../../shared/projects';
import type {
  Project,
  ProjectCreateInput,
  ProjectCreateResult,
  StepMarker,
} from '../../shared/types';
import { createProjectCore } from '../create-project';
import { touchDirtyMarker } from '../dirty';
import {
  cleanDirRelPath,
  createProjectEntry,
  listProjectFiles,
  requireCreatableName,
} from '../files';
import { addStep, editStepText, toggleStep, transitionStatus, writeNote } from '../mutate';
import { createProjectNote, readNote } from '../note';
import { parseReadmeCached } from '../parse-cache';
import { requirePathUnder } from '../path-bounds';
import { readSettings, settingsPath } from '../settings';
import { findProjectReadmes } from '../walk';
import { checkBranchState } from '../worktree-ops';
import { requireMainWindowSender, requireNonEmptyString, requireString } from './utils';

/**
 * Defence-in-depth: every IPC handler that accepts a `path` from the
 * renderer and reads or writes the filesystem at that path runs through
 * here first. Realpathed bound check against the current conception
 * root via shared/path-bounds.
 */
async function assertUnderConception(path: string): Promise<void> {
  const { lastConceptionPath: conceptionPath } = await readSettings();
  if (!conceptionPath) {
    throw new Error('no conception path is set');
  }
  await requirePathUnder(path, conceptionPath);
}

/**
 * Resolve + bound the parent directory a `createProjectFile` /
 * `createProjectDir` call targets. Two nested realpath bounds, both applied
 * here at the handler choke point (path-bounds convention):
 *
 *  1. the project directory (parent of `projectPath`, which is the README
 *     path — or the directory itself) must resolve under the conception's
 *     `projects/` tree — these verbs create entries, so they get a tighter
 *     bound than the read-side `assertUnderConception`;
 *  2. the target's parent (`<projectDir>/<dirRelPath>`) must exist and
 *     resolve back under the project directory, so a symlinked subdir can't
 *     smuggle the create outside the tree.
 *
 * Returns the canonical absolute parent directory to create into.
 */
async function resolveCreateParent(projectPath: string, dirRelPath: string): Promise<string> {
  const { lastConceptionPath: conceptionPath } = await readSettings();
  if (!conceptionPath) throw new Error('no conception path is set');
  const projectDir =
    basename(projectPath).toLowerCase() === 'readme.md' ? dirname(projectPath) : projectPath;
  const projectDirReal = await requirePathUnder(projectDir, join(conceptionPath, 'projects'));
  const rel = cleanDirRelPath(dirRelPath);
  const parentAbs = rel === '' ? projectDirReal : join(projectDirReal, rel);
  return requirePathUnder(parentAbs, projectDirReal);
}

/**
 * Slim a parsed project for the resident list: drop the unbounded `timeline[]`
 * (it grows with a project's age — G1) while keeping the precomputed
 * `lastActivity` scalar the card needs. The preview lazy-fetches the full
 * project (with `timeline`) via `getProject`. Returns the cached object
 * untouched when there's nothing to trim; otherwise a shallow copy so the
 * parse-cache entry keeps its full timeline.
 */
function toListProjection(project: Project): Project {
  if (project.timeline.length === 0) return project;
  return { ...project, timeline: [] };
}

async function listProjects(): Promise<Project[]> {
  const { lastConceptionPath: conceptionPath } = await readSettings();
  if (!conceptionPath) return [];

  const readmes = await findProjectReadmes(conceptionPath);
  // parseReadmeCached memoises on path + mtime, so a reload with no file changes
  // re-parses nothing — the R2 fix for the whole-tree re-parse on every reload.
  const projects = (await Promise.all(readmes.map(parseReadmeCached))).map(toListProjection);

  return projects.sort(compareByStatusThenSlug);
}

async function getProject(path: string): Promise<Project | null> {
  try {
    return await parseReadmeCached(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function readBranchFromReadme(readmePath: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(readmePath, 'utf8');
    return parseHeader(raw).branch;
  } catch {
    return null;
  }
}

function buildBranchWarning(
  branch: string,
  lingeringWorktrees: { expectedWorktree: string }[],
  lingeringBranches: { name: string }[],
): string {
  const parts: string[] = [];
  if (lingeringWorktrees.length > 0) {
    const paths = lingeringWorktrees.map((r) => r.expectedWorktree).join(', ');
    parts.push(`worktree(s) still on disk at ${paths}`);
  }
  if (lingeringBranches.length > 0) {
    const repos = lingeringBranches.map((r) => r.name).join(', ');
    parts.push(`local branch '${branch}' still exists in ${repos}`);
  }
  return `${parts.join('; ')} — run \`condash worktrees remove ${branch}\` then \`git branch -d ${branch}\` to clean up.`;
}

/**
 * Wire IPC verbs covering project enumeration, README parsing, step
 * mutations, status transitions, project creation, note read/write, and
 * raw settings.json access (settings.read/writeRaw target a project-style
 * note path so they live with the rest of the note plumbing).
 */
export function registerProjectsIpc(): void {
  ipcMain.handle('listProjects', (event) => {
    requireMainWindowSender(event);
    return listProjects();
  });

  ipcMain.handle('getProject', async (event, path: string) => {
    requireMainWindowSender(event);
    await assertUnderConception(path);
    return getProject(path);
  });

  ipcMain.handle(
    'toggleStep',
    async (
      event,
      path: string,
      lineIndex: number,
      expectedMarker: StepMarker,
      newMarker: StepMarker,
    ) => {
      requireMainWindowSender(event);
      await assertUnderConception(path);
      return toggleStep(path, lineIndex, expectedMarker, newMarker);
    },
  );

  ipcMain.handle(
    'editStepText',
    async (event, path: string, lineIndex: number, expectedText: string, newText: string) => {
      requireMainWindowSender(event);
      await assertUnderConception(path);
      return editStepText(path, lineIndex, expectedText, newText);
    },
  );

  ipcMain.handle('addStep', async (event, path: string, text: string) => {
    requireMainWindowSender(event);
    await assertUnderConception(path);
    return addStep(path, text);
  });

  ipcMain.handle('listProjectFiles', async (event, path: string) => {
    requireMainWindowSender(event);
    await assertUnderConception(path);
    return listProjectFiles(path);
  });

  ipcMain.handle(
    'setStatus',
    async (event, path: string, newStatus: string, opts?: { summary?: string }) => {
      requireMainWindowSender(event);
      // Bound at the IPC layer like every sibling path-accepting handler —
      // setStatus previously skipped this, the lone gap D1-4 flagged.
      await assertUnderConception(path);
      const result = await transitionStatus(path, newStatus, opts);
      // Touch the dirty marker so a follow-up `condash projects index` is
      // surfaced. Best-effort: if the conception path isn't set we just
      // skip it — the in-memory list rebuild still happens via the watcher.
      const { lastConceptionPath: conceptionPath } = await readSettings();
      if (conceptionPath) {
        await touchDirtyMarker(conceptionPath, 'projects').catch((err) => {
          console.error('[setStatus] touchDirtyMarker failed', err);
        });
        // On close (done-edge: prev !== done, new === done), surface any
        // leftover-branch warnings so the GUI can toast them — silently
        // swallowing the miss let the same broken cleanup ship twice in
        // April. Keep the call best-effort so a failed probe never blocks
        // the close itself.
        if (result.timelineAppended && /^- .* — Closed/.test(result.timelineAppended)) {
          const branch = await readBranchFromReadme(path);
          if (branch) {
            try {
              const state = await checkBranchState(conceptionPath, branch);
              const lingeringWorktrees = state.repos.filter((r) => r.worktreeExists);
              const lingeringBranches = state.repos.filter((r) => r.localBranchExists);
              if (lingeringWorktrees.length > 0 || lingeringBranches.length > 0) {
                result.branchWarning = buildBranchWarning(
                  branch,
                  lingeringWorktrees,
                  lingeringBranches,
                );
              }
            } catch {
              // Best-effort probe — never block the close on its own failure.
            }
          }
        }
      }
      return result;
    },
  );

  ipcMain.handle(
    'createProject',
    async (event, input: ProjectCreateInput): Promise<ProjectCreateResult> => {
      requireMainWindowSender(event);
      const { lastConceptionPath: conceptionPath } = await readSettings();
      if (!conceptionPath) throw new Error('No conception path set');
      const result = await createProjectCore(conceptionPath, {
        kind: input.kind,
        slug: input.slug,
        title: input.title,
        // Apps stays empty for the GUI quick-create form; users fill it in
        // by editing the README or via the popup.
        apps: [],
        branch: null,
        base: null,
        // The renderer asked for status `now | review | later | backlog`.
        // createProjectCore writes it into the YAML directly — no post-flip
        // via transitionStatus needed, since none of the four edges
        // transitionStatus's done-edge logic.
        status: input.status,
        severity: input.severity ?? null,
        severityImpact: input.severityImpact ?? null,
        environment: input.environment ?? null,
      });
      return {
        slug: result.slug,
        path: result.path,
        relPath: result.relPath,
        readme: result.readme,
      };
    },
  );

  ipcMain.handle('readNote', async (event, path: string) => {
    requireMainWindowSender(event);
    await assertUnderConception(path);
    return readNote(path);
  });

  ipcMain.handle(
    'writeNote',
    async (event, path: string, expectedContent: string, newContent: string) => {
      requireMainWindowSender(event);
      await assertUnderConception(path);
      return writeNote(path, expectedContent, newContent);
    },
  );

  // Raw read of the per-machine `settings.json`. Used by the Settings modal
  // to compute inheritance badges (compare global vs. condash.json values)
  // and to drive the Global-tab editor through the same patchConfig flow it
  // uses for condash.json. Returns `''` when the file doesn't exist yet —
  // the modal treats that as "fresh defaults" and creates the file on first
  // save.
  ipcMain.handle('getGlobalSettingsRaw', async (event) => {
    requireMainWindowSender(event);
    return readNote(settingsPath());
  });

  // Atomic CAS write to settings.json. Canonicalises through
  // `globalSettingsSchema` (handled by `writeNote`'s basename dispatch).
  // Returns the bytes actually written so the caller can keep its CAS
  // baseline aligned with disk after Zod re-orders keys.
  ipcMain.handle(
    'writeGlobalSettings',
    async (event, expectedContent: string, newContent: string) => {
      requireMainWindowSender(event);
      return writeNote(settingsPath(), expectedContent, newContent);
    },
  );

  ipcMain.handle('createProjectNote', async (event, projectPath: string, slug: string) => {
    requireMainWindowSender(event);
    await assertUnderConception(projectPath);
    return createProjectNote(projectPath, slug);
  });

  ipcMain.handle(
    'createProjectFile',
    async (event, projectPath: string, dirRelPath: string, name: string) => {
      requireMainWindowSender(event);
      requireNonEmptyString('createProjectFile', projectPath);
      requireString('createProjectFile', dirRelPath);
      requireNonEmptyString('createProjectFile', name);
      const cleanName = requireCreatableName(name);
      const parent = await resolveCreateParent(projectPath, dirRelPath);
      return createProjectEntry(parent, cleanName, 'file');
    },
  );

  ipcMain.handle(
    'createProjectDir',
    async (event, projectPath: string, dirRelPath: string, name: string) => {
      requireMainWindowSender(event);
      requireNonEmptyString('createProjectDir', projectPath);
      requireString('createProjectDir', dirRelPath);
      requireNonEmptyString('createProjectDir', name);
      const cleanName = requireCreatableName(name);
      const parent = await resolveCreateParent(projectPath, dirRelPath);
      return createProjectEntry(parent, cleanName, 'dir');
    },
  );
}
