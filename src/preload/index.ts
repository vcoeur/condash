import { contextBridge, ipcRenderer } from 'electron';
import type { CondashApi } from '../shared/api';
import type { TermDataMessage, TermExitMessage, TreeEvent } from '../shared/types';

const api: CondashApi = {
  listProjects: () => ipcRenderer.invoke('listProjects'),
  getProject: (path) => ipcRenderer.invoke('getProject', path),
  readKnowledgeTree: () => ipcRenderer.invoke('readKnowledgeTree'),
  search: (query) => ipcRenderer.invoke('search', query),
  listRepos: () => ipcRenderer.invoke('listRepos'),
  listOpenWith: () => ipcRenderer.invoke('listOpenWith'),
  launchOpenWith: (slot, path) => ipcRenderer.invoke('launchOpenWith', slot, path),
  forceStopRepo: (repoName) => ipcRenderer.invoke('forceStopRepo', repoName),
  openInEditor: (path) => ipcRenderer.invoke('openInEditor', path),
  pickConceptionPath: () => ipcRenderer.invoke('pickConceptionPath'),
  getConceptionPath: () => ipcRenderer.invoke('getConceptionPath'),
  getTheme: () => ipcRenderer.invoke('getTheme'),
  setTheme: (theme) => ipcRenderer.invoke('setTheme', theme),
  toggleStep: (path, lineIndex, expectedMarker, newMarker) =>
    ipcRenderer.invoke('toggleStep', path, lineIndex, expectedMarker, newMarker),
  setStatus: (path, newStatus) => ipcRenderer.invoke('setStatus', path, newStatus),
  readNote: (path) => ipcRenderer.invoke('readNote', path),
  writeNote: (path, expectedContent, newContent) =>
    ipcRenderer.invoke('writeNote', path, expectedContent, newContent),
  onTreeEvents: (callback) => {
    const handler = (_: unknown, events: TreeEvent[]): void => callback(events);
    ipcRenderer.on('tree-events', handler);
    return () => {
      ipcRenderer.removeListener('tree-events', handler);
    };
  },
  termSpawn: (request) => ipcRenderer.invoke('term.spawn', request),
  termWrite: (id, data) => ipcRenderer.invoke('term.write', id, data),
  termResize: (id, cols, rows) => ipcRenderer.invoke('term.resize', id, cols, rows),
  termClose: (id) => ipcRenderer.invoke('term.close', id),
  termGetPrefs: () => ipcRenderer.invoke('term.getPrefs'),
  termLatestScreenshot: (dir) => ipcRenderer.invoke('term.latestScreenshot', dir),
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
};

contextBridge.exposeInMainWorld('condash', api);
