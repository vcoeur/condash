/**
 * Unit tests for the shared `safeSend` main→renderer push helper (E5). Locks the
 * return-boolean contract and the disposed/crashed-frame guards so every push
 * channel that now routes through it (terminals, watcher, repo-watchers,
 * task-scheduler, dashboard, menu) inherits the same behaviour.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { safeSend } from './safe-send';

/** Minimal `WebContents` stub — only the three methods `safeSend` touches. */
function fakeWc(opts: {
  destroyed?: boolean;
  crashed?: boolean;
  throwOnSend?: boolean;
}): WebContents & { sent: Array<{ channel: string; payload: unknown }> } {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    isDestroyed: () => opts.destroyed ?? false,
    isCrashed: () => opts.crashed ?? false,
    send: (channel: string, payload: unknown) => {
      if (opts.throwOnSend) throw new Error('Render frame was disposed');
      sent.push({ channel, payload });
    },
  } as unknown as WebContents & { sent: Array<{ channel: string; payload: unknown }> };
}

describe('safeSend', () => {
  it('delivers to a live frame and reports true', () => {
    const wc = fakeWc({});
    expect(safeSend(wc, 'chan', { a: 1 })).toBe(true);
    expect(wc.sent).toEqual([{ channel: 'chan', payload: { a: 1 } }]);
  });

  it('drops (returns false, never calls send) when the frame is destroyed', () => {
    const wc = fakeWc({ destroyed: true });
    const spy = vi.spyOn(wc, 'send');
    expect(safeSend(wc, 'chan', 1)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('drops when the render process has crashed', () => {
    const wc = fakeWc({ crashed: true });
    const spy = vi.spyOn(wc, 'send');
    expect(safeSend(wc, 'chan', 1)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('swallows a throw from send (disposed-but-not-destroyed) and reports false', () => {
    const wc = fakeWc({ throwOnSend: true });
    expect(safeSend(wc, 'chan', 1)).toBe(false);
  });
});
