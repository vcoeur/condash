// Surface chokidar watcher failures to the user (W3). A watcher error — most
// importantly inotify exhaustion (EMFILE / ENOSPC) — leaves FS coverage
// silently partial: dirty counts, upstream status, and tree views stop
// auto-updating until an unrelated event or an F5. The bare `console.error`
// the handlers used to do never reached the user, so the app looked frozen
// with no signal. This module turns an error into an actionable message and
// pushes it to every renderer as a toast over the `watcher-status` channel.
import { BrowserWindow } from 'electron';
import { EVENT_CHANNELS } from '../shared/ipc-channels';
import type { WatcherStatusMessage } from '../shared/api';
import { safeSend } from './safe-send';

/**
 * Build a user-facing, actionable message for a chokidar watcher error.
 *
 * @param err the error the chokidar `error` event carried.
 * @param context short label of what was being watched (e.g. a repo path).
 */
export function describeWatcherError(err: unknown, context: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EMFILE' || code === 'ENOSPC') {
    return `File-watch limit reached (${code}) watching ${context}. Some views may stop auto-updating — raise the inotify limit (sysctl fs.inotify.max_user_watches / max_user_instances) and reload (F5).`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `File watcher error (${context}): ${detail}. Some views may not auto-update; press F5 to refresh.`;
}

/**
 * Push a watcher-status notice to every live renderer. Best-effort — a dropped
 * send (no live frame) is fine; the message is advisory.
 */
function pushWatcherStatus(message: string, kind: WatcherStatusMessage['kind'] = 'error'): void {
  const payload: WatcherStatusMessage = { message, kind };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSend(win.webContents, EVENT_CHANNELS.watcherStatus, payload);
  }
}

/**
 * Standard handling for a chokidar `error` event: log it (kept for the
 * dev/stderr trail) and surface an actionable toast to the user.
 */
export function reportWatcherError(err: unknown, context: string): void {
  console.error(`[watcher] ${context}:`, err);
  pushWatcherStatus(describeWatcherError(err, context));
}
