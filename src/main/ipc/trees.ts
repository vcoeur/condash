import { ipcMain } from 'electron';
import { readKnowledgeTree } from '../knowledge';
import { readNote } from '../note';
import { readResourcesTree } from '../resources';
import { requireReadableSkillPath } from '../path-bounds';
import { readSkillsTreeForScope } from '../skills';
import { search } from '../search';
import { readSettings } from '../settings';
import { treeCreateMd, treeImportFile, treeMkdir } from '../tree-mutations';
import { emptySearchResults, type SkillScope, type TreeRoot } from '../../shared/types';
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

  // Returns a well-formed empty `SearchResults` (not a bare `[]`) when no
  // conception path is set, so the declared `Promise<SearchResults>` contract
  // is honest — the renderer can destructure `{ hits }` without defensive
  // optional-chaining.
  ipcMain.handle('search', async (_, query: string, scopes?: string[]) => {
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) return emptySearchResults();
    return search(conceptionPath, query, scopes);
  });
}
