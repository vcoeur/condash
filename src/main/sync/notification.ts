import { Notification } from 'electron';
import { basename } from 'node:path';
import type { AutoSyncStatus } from '../../shared/types';

/** Electron-only adapter; never imported by the CLI's sync graph. */
export function notifyBlockedSync(
  path: string,
  episode: NonNullable<AutoSyncStatus['blockedEpisode']>,
): void {
  if (!Notification.isSupported()) return;
  const waiting =
    episode.waitingCommits === null
      ? 'Waiting commit count unknown'
      : `${episode.waitingCommits} commit(s) waiting to push`;
  new Notification({
    title: `condash: integration needed — ${basename(path)}`,
    body: `${waiting}. First detected ${new Date(episode.since).toLocaleString()}. Local commits are retained; reconcile upstream, then sync again.`,
  }).show();
}
