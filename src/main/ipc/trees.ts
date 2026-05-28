import { ipcMain } from 'electron';
import { readKnowledgeTree } from '../knowledge';
import { readNote } from '../note';
import { readResourcesTree } from '../resources';
import { requireReadableSkillPath } from '../path-bounds';
import { readSkillsTreeForScope } from '../skills';
import { search } from '../search';
import { readSettings } from '../settings';
import { treeCreateMd, treeImportFile, treeMkdir } from '../tree-mutations';
import type { SkillScope, TreeRoot } from '../../shared/types';
import { withConception } from './utils';

/** Coerce renderer-supplied scope to the enum, defaulting to conception. */
function asScope(raw: unknown): SkillScope {
  return raw === 'user' ? 'user' : 'conception';
}

/**
 * Wire the read/write IPC for the three conception-scoped trees
 * (knowledge, resources, skills) plus the cross-tree search verb.
 * Tree mutation handlers (`treeCreateMd`, `treeMkdir`, `treeImportFile`)
 * are conception-scoped through the shared tree-mutations layer.
 */
export function registerTreesIpc(): void {
  ipcMain.handle('readKnowledgeTree', () =>
    withConception((conceptionPath) => readKnowledgeTree(conceptionPath), null),
  );

  ipcMain.handle('readResourcesTree', () =>
    withConception((conceptionPath) => readResourcesTree(conceptionPath), null),
  );

  ipcMain.handle('readSkillsTree', (_, rawScope: unknown) =>
    withConception(
      (conceptionPath) => readSkillsTreeForScope(asScope(rawScope), conceptionPath),
      null,
    ),
  );

  // Read-only content fetch for a Skills-pane file. Unlike `readNote` this
  // also permits the user-scope skill + AGENTS.md locations (user scope
  // lives outside the conception) — bounded by `requireReadableSkillPath`.
  ipcMain.handle('readSkillFile', async (_, path: string) => {
    const real = await requireReadableSkillPath(path);
    return readNote(real);
  });

  ipcMain.handle('treeCreateMd', (_, root: TreeRoot, dirRelPath: string, filename: string) =>
    treeCreateMd(root, dirRelPath, filename),
  );

  ipcMain.handle('treeMkdir', (_, root: TreeRoot, dirRelPath: string, name: string) =>
    treeMkdir(root, dirRelPath, name),
  );

  ipcMain.handle('treeImportFile', (_, root: TreeRoot, dirRelPath: string) =>
    treeImportFile(root, dirRelPath),
  );

  // The original handler returned `[]` when no conception path was set;
  // typed as `SearchResults` by the api but the renderer guards against
  // either shape. Preserve verbatim — behaviour-preserving extract.
  ipcMain.handle('search', async (_, query: string) => {
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) return [];
    return search(conceptionPath, query);
  });
}
