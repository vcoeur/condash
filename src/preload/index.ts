import { contextBridge, ipcRenderer } from 'electron';
import type { CondashApi } from '../shared/api';

const api: CondashApi = {
  listProjects: () => ipcRenderer.invoke('listProjects'),
  readKnowledgeTree: () => ipcRenderer.invoke('readKnowledgeTree'),
  search: (query) => ipcRenderer.invoke('search', query),
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
  onTreeChanged: (callback) => {
    const handler = (): void => callback();
    ipcRenderer.on('tree-changed', handler);
    return () => {
      ipcRenderer.removeListener('tree-changed', handler);
    };
  },
};

contextBridge.exposeInMainWorld('condash', api);
