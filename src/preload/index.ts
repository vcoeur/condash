import { contextBridge, ipcRenderer } from 'electron';
import type { CondashApi, MenuCommand } from '../shared/api';
import type {
  RepoEvent,
  TermDataMessage,
  TermExitMessage,
  TermSession,
  TreeEvent,
} from '../shared/types';

const api: CondashApi = {
  listProjects: () => ipcRenderer.invoke('listProjects'),
  getProject: (path) => ipcRenderer.invoke('getProject', path),
  readKnowledgeTree: () => ipcRenderer.invoke('readKnowledgeTree'),
  search: (query) => ipcRenderer.invoke('search', query),
  listRepos: () => ipcRenderer.invoke('listRepos'),
  invalidateGitStatus: () => ipcRenderer.invoke('invalidateGitStatus'),
  getDirtyDetails: (path, opts) => ipcRenderer.invoke('getDirtyDetails', path, opts),
  listOpenWith: () => ipcRenderer.invoke('listOpenWith'),
  launchOpenWith: (slot, path) => ipcRenderer.invoke('launchOpenWith', slot, path),
  forceStopRepo: (repoName) => ipcRenderer.invoke('forceStopRepo', repoName),
  openInEditor: (path) => ipcRenderer.invoke('openInEditor', path),
  pickConceptionPath: () => ipcRenderer.invoke('pickConceptionPath'),
  getConceptionPath: () => ipcRenderer.invoke('getConceptionPath'),
  detectConceptionState: (path) => ipcRenderer.invoke('detectConceptionState', path),
  initConception: (path) => ipcRenderer.invoke('initConception', path),
  getTheme: () => ipcRenderer.invoke('getTheme'),
  setTheme: (theme) => ipcRenderer.invoke('setTheme', theme),
  getLayout: () => ipcRenderer.invoke('getLayout'),
  setLayout: (layout) => ipcRenderer.invoke('setLayout', layout),
  getWelcomeDismissed: () => ipcRenderer.invoke('getWelcomeDismissed'),
  setWelcomeDismissed: (value) => ipcRenderer.invoke('setWelcomeDismissed', value),
  getSettingsPath: () => ipcRenderer.invoke('getSettingsPath'),
  toggleStep: (path, lineIndex, expectedMarker, newMarker) =>
    ipcRenderer.invoke('step.toggle', path, lineIndex, expectedMarker, newMarker),
  editStepText: (path, lineIndex, expectedText, newText) =>
    ipcRenderer.invoke('step.editText', path, lineIndex, expectedText, newText),
  addStep: (path, text) => ipcRenderer.invoke('step.add', path, text),
  listProjectFiles: (path) => ipcRenderer.invoke('listProjectFiles', path),
  setStatus: (path, newStatus) => ipcRenderer.invoke('setStatus', path, newStatus),
  readNote: (path) => ipcRenderer.invoke('note.read', path),
  writeNote: (path, expectedContent, newContent) =>
    ipcRenderer.invoke('note.write', path, expectedContent, newContent),
  helpReadDoc: (name) => ipcRenderer.invoke('help.readDoc', name),
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
  termSpawn: (request) => ipcRenderer.invoke('term.spawn', request),
  termWrite: (id, data) => ipcRenderer.invoke('term.write', id, data),
  termResize: (id, cols, rows) => ipcRenderer.invoke('term.resize', id, cols, rows),
  termClose: (id) => ipcRenderer.invoke('term.close', id),
  termGetPrefs: () => ipcRenderer.invoke('term.getPrefs'),
  termSetPrefs: (prefs) => ipcRenderer.invoke('term.setPrefs', prefs),
  termLatestScreenshot: (dir) => ipcRenderer.invoke('term.latestScreenshot', dir),
  termList: () => ipcRenderer.invoke('term.list'),
  termAttach: (id) => ipcRenderer.invoke('term.attach', id),
  termSetSide: (id, side) => ipcRenderer.invoke('term.setSide', id, side),
  onTermData: (callback) => {
    const handler = (_: unknown, msg: TermDataMessage): void => callback(msg);
    ipcRenderer.on('term.data', handler);
    return () => ipcRenderer.removeListener('term.data', handler);
  },
  onTermExit: (callback) => {
    const handler = (_: unknown, msg: TermExitMessage): void => callback(msg);
    ipcRenderer.on('term.exit', handler);
    return () => ipcRenderer.removeListener('term.exit', handler);
  },
  onTermSessions: (callback) => {
    const handler = (_: unknown, sessions: TermSession[]): void => callback(sessions);
    ipcRenderer.on('term.sessions', handler);
    return () => ipcRenderer.removeListener('term.sessions', handler);
  },
  openConceptionDirectory: () => ipcRenderer.invoke('openConceptionDirectory'),
  openExternal: (target: string) => ipcRenderer.invoke('openExternal', target),
  openPath: (target: string) => ipcRenderer.invoke('openPath', target),
  createProjectNote: (projectPath: string, slug: string) =>
    ipcRenderer.invoke('project.createNote', projectPath, slug),
  quitApp: () => ipcRenderer.invoke('quitApp'),
  getAppInfo: () => ipcRenderer.invoke('getAppInfo'),
  pdfToFileUrl: (path: string) => ipcRenderer.invoke('pdf.toFileUrl', path),
  onMenuCommand: (callback) => {
    const handler = (_: unknown, command: MenuCommand): void => callback(command);
    ipcRenderer.on('menu-command', handler);
    return () => ipcRenderer.removeListener('menu-command', handler);
  },
};

contextBridge.exposeInMainWorld('condash', api);
