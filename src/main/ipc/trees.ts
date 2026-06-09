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
import {
  requireMainWindowSender,
  requireNonEmptyString,
  requireOptionalStringArray,
  withConception,
} from './utils';

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
  ipcMain.handle('readKnowledgeTree', (event) => {
    requireMainWindowSender(event);
    return withConception((conceptionPath) => readKnowledgeTree(conceptionPath), null);
  });

  ipcMain.handle('readResourcesTree', (event) => {
    requireMainWindowSender(event);
    return withConception((conceptionPath) => readResourcesTree(conceptionPath), null);
  });

  ipcMain.handle('readSkillsTree', (event, rawScope: unknown) => {
    requireMainWindowSender(event);
    return withConception(
      (conceptionPath) => readSkillsTreeForScope(asScope(rawScope), conceptionPath),
      null,
    );
  });

  // Read-only content fetch for a Skills-pane file. Unlike `readNote` this
  // also permits the user-scope skill + AGENTS.md locations (user scope
  // lives outside the conception) — bounded by `requireReadableSkillPath`.
  ipcMain.handle('readSkillFile', async (event, path: string) => {
    requireMainWindowSender(event);
    const real = await requireReadableSkillPath(path);
    return readNote(real);
  });

  ipcMain.handle('treeCreateMd', (event, root: TreeRoot, dirRelPath: string, filename: string) => {
    requireMainWindowSender(event);
    return treeCreateMd(root, dirRelPath, filename);
  });

  ipcMain.handle('treeMkdir', (event, root: TreeRoot, dirRelPath: string, name: string) => {
    requireMainWindowSender(event);
    return treeMkdir(root, dirRelPath, name);
  });

  ipcMain.handle('treeImportFile', (event, root: TreeRoot, dirRelPath: string) => {
    requireMainWindowSender(event);
    return treeImportFile(root, dirRelPath);
  });

  // Returns a well-formed empty `SearchResults` (not a bare `[]`) when no
  // conception path is set, so the declared `Promise<SearchResults>` contract
  // is honest — the renderer can destructure `{ hits }` without defensive
  // optional-chaining. An empty query gets the same shape: the renderer
  // gates sub-MIN_QUERY_LEN input client-side, so a blank query here is a
  // no-op, not an error; any non-string query is a contract violation.
  ipcMain.handle('search', async (event, query: unknown, scopes?: unknown) => {
    requireMainWindowSender(event);
    if (query === '') return emptySearchResults();
    const q = requireNonEmptyString('search', query);
    const validScopes = requireOptionalStringArray('search', scopes);
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) return emptySearchResults();
    return search(conceptionPath, q, validScopes);
  });
}
