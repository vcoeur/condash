import type { WebContents } from 'electron';

/**
 * Send an event to a renderer, tolerating a webContents whose render process
 * has crashed or whose frame was disposed (render-process-gone) but which
 * `isDestroyed()` still reports as live. After an OOM kill or renderer crash the
 * frame is disposed-but-not-destroyed, so a bare `.send` logs "Render frame was
 * disposed before WebFrameMain could be accessed" and can throw. A main-side push
 * (a pty `onData`/`onExit` callback, a watcher/scheduler/dashboard tick, a menu
 * click) runs outside any request scope, so an escaping throw there would take the
 * whole main process (and every tab) down — guard the crashed state and swallow any
 * residual throw so a dead renderer stays local.
 *
 * Returns whether the payload was actually handed to a live frame — a dropped
 * send must not be counted as in-flight by the flow controller (no ack will
 * ever arrive for it, and the stale count would pin the pty paused; L3).
 *
 * @param wc The target renderer's webContents.
 * @param channel The IPC push-event channel (an `EVENT_CHANNELS` value).
 * @param payload The serialisable event payload.
 * @returns True when the payload reached a live frame, false when it was dropped.
 */
export function safeSend(wc: WebContents, channel: string, payload: unknown): boolean {
  if (wc.isDestroyed() || wc.isCrashed()) return false;
  try {
    wc.send(channel, payload);
    return true;
  } catch {
    /* frame disposed between the check and the send — drop the event */
    return false;
  }
}
