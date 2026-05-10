import { ipcMain } from 'electron';
import { resolveConceptionPaths } from '../conception-paths';
import { readKnowledgeTree } from '../knowledge';
import { readResourcesTree } from '../resources';
import { readSkillsTree } from '../skills';
import { search } from '../search';
import { readSettings } from '../settings';
import { treeCreateMd, treeImportFile, treeMkdir } from '../tree-mutations';
import type { TreeRoot } from '../../shared/types';
import { withConception } from './utils';

/**
 * Wire the read/write IPC for the three conception-scoped trees
 * (knowledge, resources, skills) plus the cross-tree search verb.
 * Tree mutation handlers (`tree.createMd`, `tree.mkdir`, `tree.importFile`)
 * are conception-scoped through the shared tree-mutations layer.
 */
export function registerTreesIpc(): void {
  ipcMain.handle('readKnowledgeTree', () =>
    withConception((conceptionPath) => readKnowledgeTree(conceptionPath), null),
  );

  ipcMain.handle('readResourcesTree', () =>
    withConception(async (conceptionPath) => {
      const { resources } = await resolveConceptionPaths(conceptionPath);
      return readResourcesTree(conceptionPath, resources);
    }, null),
  );

  ipcMain.handle('readSkillsTree', () =>
    withConception(async (conceptionPath) => {
      const { skills } = await resolveConceptionPaths(conceptionPath);
      return readSkillsTree(conceptionPath, skills);
    }, null),
  );

  ipcMain.handle('tree.createMd', (_, root: TreeRoot, dirRelPath: string, filename: string) =>
    treeCreateMd(root, dirRelPath, filename),
  );

  ipcMain.handle('tree.mkdir', (_, root: TreeRoot, dirRelPath: string, name: string) =>
    treeMkdir(root, dirRelPath, name),
  );

  ipcMain.handle('tree.importFile', (_, root: TreeRoot, dirRelPath: string) =>
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
