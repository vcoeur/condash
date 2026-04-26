import { contextBridge, ipcRenderer } from 'electron';
import type { CondashApi } from '../shared/api';

const api: CondashApi = {
  listProjects: () => ipcRenderer.invoke('listProjects'),
  openInEditor: (path) => ipcRenderer.invoke('openInEditor', path),
  pickConceptionPath: () => ipcRenderer.invoke('pickConceptionPath'),
  getConceptionPath: () => ipcRenderer.invoke('getConceptionPath'),
};

contextBridge.exposeInMainWorld('condash', api);
