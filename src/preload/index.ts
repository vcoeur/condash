import { contextBridge, ipcRenderer } from 'electron';
import type { CondashApi, MenuCommand } from '../shared/api';
import { EVENT_CHANNELS } from '../shared/ipc-channels';
import type {
  DashboardState,
  DashboardTabSummariesMessage,
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
  readResourcesTree: () => ipcRenderer.invoke('readResourcesTree'),
  readSkillsTree: (scope) => ipcRenderer.invoke('readSkillsTree', scope),
  readSkillFile: (path) => ipcRenderer.invoke('readSkillFile', path),
  search: (query, scopes) => ipcRenderer.invoke('search', query, scopes),
  listRepos: () => ipcRenderer.invoke('listRepos'),
  listReposForPrimary: (primaryName) => ipcRenderer.invoke('listReposForPrimary', primaryName),
  invalidateGitStatus: () => ipcRenderer.invoke('invalidateGitStatus'),
  getDirtyDetails: (path, opts) => ipcRenderer.invoke('getDirtyDetails', path, opts),
  listOpenWith: () => ipcRenderer.invoke('listOpenWith'),
  launchOpenWith: (slot, path) => ipcRenderer.invoke('launchOpenWith', slot, path),
  forceStopRepo: (repoName) => ipcRenderer.invoke('forceStopRepo', repoName),
  pullBranch: (path) => ipcRenderer.invoke('pullBranch', path),
  lookupPullRequest: (path, branch) => ipcRenderer.invoke('lookupPullRequest', path, branch),
  listOpenPullRequests: (app) => ipcRenderer.invoke('listOpenPullRequests', app),
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
  listRunningTaskRuns: () => ipcRenderer.invoke('listRunningTaskRuns'),
  killTaskRun: (sid) => ipcRenderer.invoke('killTaskRun', sid),
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
  exportNotePdf: (path, html) => ipcRenderer.invoke('exportNotePdf', path, html),
  onTreeEvents: (callback) => {
    const handler = (_: unknown, events: TreeEvent[]): void => callback(events);
    ipcRenderer.on(EVENT_CHANNELS.treeEvents, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.treeEvents, handler);
    };
  },
  onRepoEvents: (callback) => {
    const handler = (_: unknown, events: RepoEvent[]): void => callback(events);
    ipcRenderer.on(EVENT_CHANNELS.repoEvents, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.repoEvents, handler);
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
    ipcRenderer.on(EVENT_CHANNELS.termData, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.termData, handler);
  },
  onTermExit: (callback) => {
    const handler = (_: unknown, msg: TermExitMessage): void => callback(msg);
    ipcRenderer.on(EVENT_CHANNELS.termExit, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.termExit, handler);
  },
  onTermSessions: (callback) => {
    const handler = (_: unknown, sessions: TermSession[]): void => callback(sessions);
    ipcRenderer.on(EVENT_CHANNELS.termSessions, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.termSessions, handler);
  },
  termTabsContext: () => ipcRenderer.invoke('termTabsContext'),
  dashboardGetState: () => ipcRenderer.invoke('dashboardGetState'),
  dashboardGetConfigView: () => ipcRenderer.invoke('dashboardGetConfigView'),
  dashboardTestConnection: (settings) => ipcRenderer.invoke('dashboardTestConnection', settings),
  dashboardRefreshTab: (sid) => ipcRenderer.invoke('dashboardRefreshTab', sid),
  onDashboardState: (callback) => {
    const handler = (_: unknown, state: DashboardState): void => callback(state);
    ipcRenderer.on(EVENT_CHANNELS.dashboardState, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.dashboardState, handler);
  },
  onDashboardTabSummaries: (callback) => {
    const handler = (_: unknown, msg: DashboardTabSummariesMessage): void => callback(msg);
    ipcRenderer.on(EVENT_CHANNELS.dashboardTabSummaries, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.dashboardTabSummaries, handler);
  },
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
    ipcRenderer.on(EVENT_CHANNELS.menuCommand, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.menuCommand, handler);
  },
  onMenuOpenRecent: (callback) => {
    const handler = (_: unknown, path: string): void => callback(path);
    ipcRenderer.on(EVENT_CHANNELS.menuOpenRecent, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.menuOpenRecent, handler);
  },
  onMenuClearRecents: (callback) => {
    const handler = (): void => callback();
    ipcRenderer.on(EVENT_CHANNELS.menuClearRecents, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNELS.menuClearRecents, handler);
  },
};

contextBridge.exposeInMainWorld('condash', api);

// Flow-control ack (review finding T1). A single dedicated `termData` listener —
// registered once here, independent of however many `onTermData` subscribers the
// app wires up — acks the bytes of each delivered payload back to main. Main
// counts sent-but-unacked bytes and pauses/resumes the pty on that backlog, so
// acking here (on receipt in the one renderer-side forwarder) bounds the dominant
// unbounded vector: the main→renderer IPC queue and the renderer event-loop
// backlog when a fast agent outruns a saturated renderer. It deliberately does
// not wait for xterm's internal parser to drain (a `term.write` callback ack) —
// that would have to be threaded through the DOM path, the fire-and-forget
// headless-worker postMessage path, the transition buffer, and both the terminal
// pane and code-run subscribers, with single-owner accounting across side/
// visibility changes. Acking once per delivered payload keeps the accounting
// exact (no residual, nothing to reset on reload) and single-owner. The main-side
// batching (T2) already keeps each payload — and thus each ack — coarse.
ipcRenderer.on(EVENT_CHANNELS.termData, (_event, msg: TermDataMessage) => {
  if (!msg || msg.data.length === 0) return;
  // Fire-and-forget: swallow any reject (e.g. a torn-down window) so a
  // high-frequency ack never surfaces as an unhandled rejection.
  void ipcRenderer.invoke('termAck', msg.id, msg.data.length).catch(() => undefined);
});
