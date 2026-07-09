/**
 * Main → renderer push-event channel names.
 *
 * The request/response (`invoke`/`handle`) channels are constrained
 * structurally: preload declares `const api: CondashApi`, so a renamed method
 * is a compile error and the channel literal can only drift on one line at a
 * time inside that typed object. The push-event channels have no such anchor —
 * each name is a bare string repeated between the `webContents.send(...)` call
 * in main and the matching `ipcRenderer.on(...)` / `removeListener(...)` calls
 * in preload, with nothing tying the two ends together. Centralising them here
 * means a rename is one edit and a typo can't silently desync the two sides.
 *
 * Keep this list to the push-event channels only; the invoke channels stay
 * keyed off the `CondashApi` method names and need no constant.
 */
export const EVENT_CHANNELS = {
  /** Conception tree (knowledge / resources / skills) change batches. */
  treeEvents: 'tree-events',
  /** Repo git-status / worktree change batches. */
  repoEvents: 'repo-events',
  /** PTY output chunk for one terminal session. */
  termData: 'termData',
  /** PTY exit notification for one terminal session. */
  termExit: 'termExit',
  /** Full terminal-session snapshot broadcast. */
  termSessions: 'termSessions',
  /** Live per-tab summaries (LLM title + popover) from the dashboard engine. */
  dashboardTabSummaries: 'dashboard-tab-summaries',
  /** Full dashboard state (overview + per-tab cards + history) snapshot. */
  dashboardState: 'dashboard-state',
  /** Live headless task-run roster — pushed on each run start / exit so the
   *  Tasks pane updates without polling. */
  taskRuns: 'task-runs',
  /** Application-menu command (e.g. show-knowledge, new-project). */
  menuCommand: 'menu-command',
  /** Open-recent menu pick, carrying the chosen conception path. */
  menuOpenRecent: 'menu-open-recent',
  /** Clear-recents menu command. */
  menuClearRecents: 'menu-clear-recents',
  /** File-watcher status notice (e.g. inotify exhaustion) → renderer toast. */
  watcherStatus: 'watcher-status',
} as const;

/**
 * Renderer → main flow-control ack (`ipcRenderer.invoke` / `ipcMain.handle`).
 *
 * Every OTHER invoke channel is keyed off a `CondashApi` method name, so its
 * literal is anchored structurally on both ends. This one lives BELOW the typed
 * surface: the preload fires it directly from its single `termData` forwarder
 * (not through `window.condash`), so no interface line ties the two ends
 * together — exactly the un-anchored-literal hazard `EVENT_CHANNELS` fixes for
 * the push channels. Named here so its literal exists once. Referenced from
 * `src/preload/index.ts` (invoke) and `src/main/ipc/terminal.ts` (handle).
 */
export const TERM_ACK_CHANNEL = 'termAck' as const;
