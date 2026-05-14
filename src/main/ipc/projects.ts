import { ipcMain } from 'electron';
import { promises as fsp } from 'node:fs';
import { parseHeader } from '../../shared/header';
import { statusOrder } from '../../shared/projects';
import type {
  Project,
  ProjectCreateInput,
  ProjectCreateResult,
  StepMarker,
} from '../../shared/types';
import { createProjectCore } from '../create-project';
import { touchDirtyMarker } from '../dirty';
import { listProjectFiles } from '../files';
import { addStep, editStepText, toggleStep, transitionStatus, writeNote } from '../mutate';
import { createProjectNote, readNote } from '../note';
import { parseReadme } from '../parse';
import { requirePathUnder } from '../path-bounds';
import { readSettings, settingsPath } from '../settings';
import { findProjectReadmes } from '../walk';
import { checkBranchState } from '../worktree-ops';

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

async function listProjects(): Promise<Project[]> {
  const { lastConceptionPath: conceptionPath } = await readSettings();
  if (!conceptionPath) return [];

  const readmes = await findProjectReadmes(conceptionPath);
  const projects = await Promise.all(readmes.map(parseReadme));

  return projects.sort((a, b) => {
    const o = statusOrder(a.status) - statusOrder(b.status);
    if (o !== 0) return o;
    return a.slug.localeCompare(b.slug);
  });
}

async function getProject(path: string): Promise<Project | null> {
  try {
    return await parseReadme(path);
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
  ipcMain.handle('listProjects', () => listProjects());

  ipcMain.handle('getProject', async (_, path: string) => {
    await assertUnderConception(path);
    return getProject(path);
  });

  ipcMain.handle(
    'toggleStep',
    async (
      _,
      path: string,
      lineIndex: number,
      expectedMarker: StepMarker,
      newMarker: StepMarker,
    ) => {
      await assertUnderConception(path);
      return toggleStep(path, lineIndex, expectedMarker, newMarker);
    },
  );

  ipcMain.handle(
    'editStepText',
    async (_, path: string, lineIndex: number, expectedText: string, newText: string) => {
      await assertUnderConception(path);
      return editStepText(path, lineIndex, expectedText, newText);
    },
  );

  ipcMain.handle('addStep', async (_, path: string, text: string) => {
    await assertUnderConception(path);
    return addStep(path, text);
  });

  ipcMain.handle('listProjectFiles', async (_, path: string) => {
    await assertUnderConception(path);
    return listProjectFiles(path);
  });

  ipcMain.handle(
    'setStatus',
    async (_, path: string, newStatus: string, opts?: { summary?: string }) => {
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
    async (_, input: ProjectCreateInput): Promise<ProjectCreateResult> => {
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
        severity: input.severity ?? null,
        severityImpact: input.severityImpact ?? null,
        environment: input.environment ?? null,
      });
      // The renderer asked for status `now | review | later | backlog`, but
      // createProjectCore always renders `Status: now`. If the user picked
      // anything else, flip it now via the same transitionStatus primitive
      // — that keeps the status-write path single-source.
      if (input.status !== 'now') {
        await transitionStatus(result.readme, input.status);
      }
      return {
        slug: result.slug,
        path: result.path,
        relPath: result.relPath,
        readme: result.readme,
      };
    },
  );

  ipcMain.handle('readNote', async (_, path: string) => {
    await assertUnderConception(path);
    return readNote(path);
  });

  ipcMain.handle(
    'writeNote',
    async (_, path: string, expectedContent: string, newContent: string) => {
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
  ipcMain.handle('getGlobalSettingsRaw', async () => readNote(settingsPath()));

  // Atomic CAS write to settings.json. Canonicalises through
  // `globalSettingsSchema` (handled by `writeNote`'s basename dispatch).
  // Returns the bytes actually written so the caller can keep its CAS
  // baseline aligned with disk after Zod re-orders keys.
  ipcMain.handle('writeGlobalSettings', async (_, expectedContent: string, newContent: string) =>
    writeNote(settingsPath(), expectedContent, newContent),
  );

  ipcMain.handle('createProjectNote', async (_, projectPath: string, slug: string) => {
    await assertUnderConception(projectPath);
    return createProjectNote(projectPath, slug);
  });
}
