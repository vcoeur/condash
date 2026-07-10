import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleBootSearchKick } from './boot-search-kick';

interface FakeWindow {
  isVisible: () => boolean;
  onceEvents: Record<string, (() => void)[]>;
  offEvents: Record<string, (() => void)[]>;
  once(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
}

function fakeWindow(visible = false): FakeWindow {
  const onceEvents: Record<string, (() => void)[]> = {};
  const offEvents: Record<string, (() => void)[]> = {};
  return {
    isVisible: () => visible,
    onceEvents,
    offEvents,
    once(event, cb) {
      (onceEvents[event] ??= []).push(cb);
    },
    off(event, cb) {
      (offEvents[event] ??= []).push(cb);
      const arr = onceEvents[event];
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
    },
  };
}

describe('scheduleBootSearchKick', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onKick after the idle delay when the window is already visible', () => {
    vi.useFakeTimers();
    const win = fakeWindow(true);
    const onKick = vi.fn();
    scheduleBootSearchKick({ win, idleMs: 100, backstopMs: 1000, onKick });
    expect(onKick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(onKick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onKick).toHaveBeenCalledTimes(1);
  });

  it('fires on the first window event', () => {
    vi.useFakeTimers();
    const win = fakeWindow(false);
    const onKick = vi.fn();
    scheduleBootSearchKick({ win, idleMs: 50, backstopMs: 1000, onKick });
    win.onceEvents['ready-to-show']![0]();
    expect(onKick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(onKick).toHaveBeenCalledTimes(1);
  });

  it('clears listeners and backstop when cleared', () => {
    vi.useFakeTimers();
    const win = fakeWindow(false);
    const onKick = vi.fn();
    const handle = scheduleBootSearchKick({ win, idleMs: 50, backstopMs: 1000, onKick });
    handle.clear();
    for (const cb of win.onceEvents['ready-to-show'] ?? []) cb();
    for (const cb of win.onceEvents['show'] ?? []) cb();
    for (const cb of win.onceEvents['focus'] ?? []) cb();
    vi.advanceTimersByTime(2000);
    expect(onKick).not.toHaveBeenCalled();
    expect(win.offEvents['ready-to-show']?.length).toBe(1);
    expect(win.offEvents['show']?.length).toBe(1);
    expect(win.offEvents['focus']?.length).toBe(1);
  });

  it('backstop fires if no window event fires', () => {
    vi.useFakeTimers();
    const win = fakeWindow(false);
    const onKick = vi.fn();
    scheduleBootSearchKick({ win, idleMs: 50, backstopMs: 200, onKick });
    // The backstop triggers kick() at 200 ms; the idle delay adds another 50 ms.
    vi.advanceTimersByTime(250);
    expect(onKick).toHaveBeenCalledTimes(1);
  });

  it('only fires once even if multiple events fire', () => {
    vi.useFakeTimers();
    const win = fakeWindow(false);
    const onKick = vi.fn();
    scheduleBootSearchKick({ win, idleMs: 10, backstopMs: 1000, onKick });
    // Capture callbacks first: the first event triggers kick() → clear(), which
    // removes the remaining listeners from the fake window.
    const ready = win.onceEvents['ready-to-show']![0];
    const show = win.onceEvents['show']![0];
    const focus = win.onceEvents['focus']![0];
    ready();
    show();
    focus();
    vi.advanceTimersByTime(20);
    expect(onKick).toHaveBeenCalledTimes(1);
  });
});
