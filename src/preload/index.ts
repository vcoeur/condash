import { contextBridge, ipcRenderer } from 'electron';
import type { CondashApi } from '../shared/api';
import type { TreeEvent } from '../shared/types';

const api: CondashApi = {
  listProjects: () => ipcRenderer.invoke('listProjects'),
  getProject: (path) => ipcRenderer.invoke('getProject', path),
  readKnowledgeTree: () => ipcRenderer.invoke('readKnowledgeTree'),
  search: (query) => ipcRenderer.invoke('search', query),
  listRepos: () => ipcRenderer.invoke('listRepos'),
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
};

contextBridge.exposeInMainWorld('condash', api);
