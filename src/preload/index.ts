import { contextBridge, ipcRenderer } from 'electron';
import type { CondashApi, MenuCommand } from '../shared/api';
import type {
  RepoEvent,
  TermAutoTitle,
  TermDataMessage,
  TermExitMessage,
  TermSession,
  TreeEvent,
} from '../shared/types';

const api: CondashApi = {
  listProjects: () => ipcRenderer.invoke('listProjects'),
  getProject: (path) => ipcRenderer.invoke('getProject', path),
  readKnowledgeTree: () => ipcRenderer.invoke('readKnowledgeTree'),
  readResourcesTree: () => ipcRenderer.invoke('readResourcesTree'),
  readSkillsTree: (scope) => ipcRenderer.invoke('readSkillsTree', scope),
  readSkillFile: (path) => ipcRenderer.invoke('readSkillFile', path),
  search: (query) => ipcRenderer.invoke('search', query),
  listRepos: () => ipcRenderer.invoke('listRepos'),
  listReposForPrimary: (primaryName) => ipcRenderer.invoke('listReposForPrimary', primaryName),
  invalidateGitStatus: () => ipcRenderer.invoke('invalidateGitStatus'),
  getDirtyDetails: (path, opts) => ipcRenderer.invoke('getDirtyDetails', path, opts),
  listOpenWith: () => ipcRenderer.invoke('listOpenWith'),
  launchOpenWith: (slot, path) => ipcRenderer.invoke('launchOpenWith', slot, path),
  forceStopRepo: (repoName) => ipcRenderer.invoke('forceStopRepo', repoName),
  openInEditor: (path) => ipcRenderer.invoke('openInEditor', path),
  pickConceptionPath: () => ipcRenderer.invoke('pickConceptionPath'),
  getConceptionPath: () => ipcRenderer.invoke('getConceptionPath'),
  openConception: (path) => ipcRenderer.invoke('openConception', path),
  getConceptionConfigPath: () => ipcRenderer.invoke('getConceptionConfigPath'),
  getRecentConceptionPaths: () => ipcRenderer.invoke('getRecentConceptionPaths'),
  clearRecentConceptionPaths: () => ipcRenderer.invoke('clearRecentConceptionPaths'),
  removeRecentConceptionPath: (path) => ipcRenderer.invoke('removeRecentConceptionPath', path),
  detectConceptionState: (path) => ipcRenderer.invoke('detectConceptionState', path),
  initConception: (path) => ipcRenderer.invoke('initConception', path),
  getTheme: () => ipcRenderer.invoke('getTheme'),
  setTheme: (theme) => ipcRenderer.invoke('setTheme', theme),
  getLayout: () => ipcRenderer.invoke('getLayout'),
  setLayout: (layout) => ipcRenderer.invoke('setLayout', layout),
  getWelcomeDismissed: () => ipcRenderer.invoke('getWelcomeDismissed'),
  setWelcomeDismissed: (value) => ipcRenderer.invoke('setWelcomeDismissed', value),
  getCardMinWidth: () => ipcRenderer.invoke('getCardMinWidth'),
  setCardMinWidth: (prefs) => ipcRenderer.invoke('setCardMinWidth', prefs),
  getTreeExpansion: () => ipcRenderer.invoke('getTreeExpansion'),
  setTreeExpansion: (prefs) => ipcRenderer.invoke('setTreeExpansion', prefs),
  getSelectedBranches: () => ipcRenderer.invoke('getSelectedBranches'),
  setSelectedBranches: (list) => ipcRenderer.invoke('setSelectedBranches', list),
  getBranchFilterStickyAll: () => ipcRenderer.invoke('getBranchFilterStickyAll'),
  setBranchFilterStickyAll: (value) => ipcRenderer.invoke('setBranchFilterStickyAll', value),
  getSkillsActiveScope: () => ipcRenderer.invoke('getSkillsActiveScope'),
  setSkillsActiveScope: (scope) => ipcRenderer.invoke('setSkillsActiveScope', scope),
  listAgents: () => ipcRenderer.invoke('listAgents'),
  listTasks: () => ipcRenderer.invoke('listTasks'),
  readTask: (slug) => ipcRenderer.invoke('readTask', slug),
  writeTask: (slug, def, previousSlug) => ipcRenderer.invoke('writeTask', slug, def, previousSlug),
  deleteTask: (slug) => ipcRenderer.invoke('deleteTask', slug),
  getSettingsPath: () => ipcRenderer.invoke('getSettingsPath'),
  getGlobalSettingsRaw: () => ipcRenderer.invoke('getGlobalSettingsRaw'),
  writeGlobalSettings: (expectedContent, newContent) =>
    ipcRenderer.invoke('writeGlobalSettings', expectedContent, newContent),
  toggleStep: (path, lineIndex, expectedMarker, newMarker) =>
    ipcRenderer.invoke('toggleStep', path, lineIndex, expectedMarker, newMarker),
  editStepText: (path, lineIndex, expectedText, newText) =>
    ipcRenderer.invoke('editStepText', path, lineIndex, expectedText, newText),
  addStep: (path, text) => ipcRenderer.invoke('addStep', path, text),
  listProjectFiles: (path) => ipcRenderer.invoke('listProjectFiles', path),
  setStatus: (path, newStatus, opts) => ipcRenderer.invoke('setStatus', path, newStatus, opts),
  createProject: (input) => ipcRenderer.invoke('createProject', input),
  readNote: (path) => ipcRenderer.invoke('readNote', path),
  writeNote: (path, expectedContent, newContent) =>
    ipcRenderer.invoke('writeNote', path, expectedContent, newContent),
  readHelpDoc: (name) => ipcRenderer.invoke('readHelpDoc', name),
  onTreeEvents: (callback) => {
    const handler = (_: unknown, events: TreeEvent[]): void => callback(events);
    ipcRenderer.on('tree-events', handler);
    return () => {
      ipcRenderer.removeListener('tree-events', handler);
    };
  },
  onRepoEvents: (callback) => {
    const handler = (_: unknown, events: RepoEvent[]): void => callback(events);
    ipcRenderer.on('repo-events', handler);
    return () => {
      ipcRenderer.removeListener('repo-events', handler);
    };
  },
  termSpawn: (request) => ipcRenderer.invoke('termSpawn', request),
  termWrite: (id, data) => ipcRenderer.invoke('termWrite', id, data),
  clipboardReadText: () => ipcRenderer.invoke('clipboardReadText'),
  termResize: (id, cols, rows) => ipcRenderer.invoke('termResize', id, cols, rows),
  termClose: (id) => ipcRenderer.invoke('termClose', id),
  termGetPrefs: () => ipcRenderer.invoke('termGetPrefs'),
  termSetPrefs: (prefs) => ipcRenderer.invoke('termSetPrefs', prefs),
  termLatestScreenshot: (dir) => ipcRenderer.invoke('termLatestScreenshot', dir),
  termList: () => ipcRenderer.invoke('termList'),
  termAttach: (id) => ipcRenderer.invoke('termAttach', id),
  termSetSide: (id, side) => ipcRenderer.invoke('termSetSide', id, side),
  onTermData: (callback) => {
    const handler = (_: unknown, msg: TermDataMessage): void => callback(msg);
    ipcRenderer.on('termData', handler);
    return () => ipcRenderer.removeListener('termData', handler);
  },
  onTermExit: (callback) => {
    const handler = (_: unknown, msg: TermExitMessage): void => callback(msg);
    ipcRenderer.on('termExit', handler);
    return () => ipcRenderer.removeListener('termExit', handler);
  },
  onTermSessions: (callback) => {
    const handler = (_: unknown, sessions: TermSession[]): void => callback(sessions);
    ipcRenderer.on('termSessions', handler);
    return () => ipcRenderer.removeListener('termSessions', handler);
  },
  onTermAutoTitles: (callback) => {
    const handler = (_: unknown, titles: TermAutoTitle[]): void => callback(titles);
    ipcRenderer.on('termAutoTitles', handler);
    return () => ipcRenderer.removeListener('termAutoTitles', handler);
  },
  termAutoTitlesList: () => ipcRenderer.invoke('termAutoTitlesList'),
  termTabsContext: () => ipcRenderer.invoke('termTabsContext'),
  logsListDays: () => ipcRenderer.invoke('logsListDays'),
  logsListSessions: (day) => ipcRenderer.invoke('logsListSessions', day),
  logsReadSession: (filePath) => ipcRenderer.invoke('logsReadSession', filePath),
  logsDeleteDay: (day) => ipcRenderer.invoke('logsDeleteDay', day),
  logsDeleteSession: (filePath) => ipcRenderer.invoke('logsDeleteSession', filePath),
  logsListTaskRuns: () => ipcRenderer.invoke('logsListTaskRuns'),
  getTaskConfig: () => ipcRenderer.invoke('getTaskConfig'),
  setTaskConfig: (slug, entry) => ipcRenderer.invoke('setTaskConfig', slug, entry),
  openConceptionDirectory: () => ipcRenderer.invoke('openConceptionDirectory'),
  openExternal: (target: string) => ipcRenderer.invoke('openExternal', target),
  openPath: (target: string) => ipcRenderer.invoke('openPath', target),
  showInFolder: (target: string) => ipcRenderer.invoke('showInFolder', target),
  createProjectNote: (projectPath: string, slug: string) =>
    ipcRenderer.invoke('createProjectNote', projectPath, slug),
  treeCreateMd: (root, dirRelPath, filename) =>
    ipcRenderer.invoke('treeCreateMd', root, dirRelPath, filename),
  treeMkdir: (root, dirRelPath, name) => ipcRenderer.invoke('treeMkdir', root, dirRelPath, name),
  treeImportFile: (root, dirRelPath) => ipcRenderer.invoke('treeImportFile', root, dirRelPath),
  quitApp: () => ipcRenderer.invoke('quitApp'),
  getAppInfo: () => ipcRenderer.invoke('getAppInfo'),
  pdfToFileUrl: (path: string) => ipcRenderer.invoke('pdfToFileUrl', path),
  onMenuCommand: (callback) => {
    const handler = (_: unknown, command: MenuCommand): void => callback(command);
    ipcRenderer.on('menu-command', handler);
    return () => ipcRenderer.removeListener('menu-command', handler);
  },
  onMenuOpenRecent: (callback) => {
    const handler = (_: unknown, path: string): void => callback(path);
    ipcRenderer.on('menu-open-recent', handler);
    return () => ipcRenderer.removeListener('menu-open-recent', handler);
  },
  onMenuClearRecents: (callback) => {
    const handler = (): void => callback();
    ipcRenderer.on('menu-clear-recents', handler);
    return () => ipcRenderer.removeListener('menu-clear-recents', handler);
  },
};

contextBridge.exposeInMainWorld('condash', api);
