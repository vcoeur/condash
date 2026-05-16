import { ipcMain } from 'electron';
import { resolveConceptionPaths } from '../conception-paths';
import { readKnowledgeTree } from '../knowledge';
import { readResourcesTree } from '../resources';
import { readSkillsTreeForTab } from '../skills';
import { search } from '../search';
import { readSettings } from '../settings';
import { treeCreateMd, treeImportFile, treeMkdir } from '../tree-mutations';
import type { SkillTab, TreeRoot } from '../../shared/types';
import { withConception } from './utils';

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
    withConception(async (conceptionPath) => {
      const { resources } = await resolveConceptionPaths(conceptionPath);
      return readResourcesTree(conceptionPath, resources);
    }, null),
  );

  ipcMain.handle('readSkillsTree', (_, tab: SkillTab) =>
    withConception(async (conceptionPath) => {
      const { skills } = await resolveConceptionPaths(conceptionPath);
      return readSkillsTreeForTab(conceptionPath, tab, skills);
    }, null),
  );

  ipcMain.handle(
    'treeCreateMd',
    (_, root: TreeRoot, dirRelPath: string, filename: string, skillTab?: SkillTab) =>
      treeCreateMd(root, dirRelPath, filename, skillTab),
  );

  ipcMain.handle(
    'treeMkdir',
    (_, root: TreeRoot, dirRelPath: string, name: string, skillTab?: SkillTab) =>
      treeMkdir(root, dirRelPath, name, skillTab),
  );

  ipcMain.handle('treeImportFile', (_, root: TreeRoot, dirRelPath: string, skillTab?: SkillTab) =>
    treeImportFile(root, dirRelPath, skillTab),
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
