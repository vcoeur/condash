/**
 * Unit tests for the extracted xterm mount helper (S2).
 *
 * The critical path is failure cleanup: if the dynamic import of xterm-mount
 * throws, the re-entrancy guard (`pendingMounts`) and the created DOM element
 * must both be released. Without this, a wedged tab can never re-mount.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountForSession, type MountSessionContext, type XtermHandle } from './mount-session';

const h = vi.hoisted(() => ({
  mountXterm: vi.fn(),
}));

vi.mock('../xterm-mount', () => ({ mountXterm: h.mountXterm }));

beforeEach(() => {
  h.mountXterm.mockReset();
  (globalThis as unknown as { document: Document }).document = {
    createElement: () => fakeElement(),
  } as unknown as Document;
});

function fakeElement(): HTMLDivElement {
  const listeners: Record<string, EventListener[]> = {};
  const element: any = {
    className: '',
    style: {} as CSSStyleDeclaration,
    parentNode: null as unknown,
    children: [] as unknown[],
    addEventListener(event: string, cb: EventListener) {
      (listeners[event] ??= []).push(cb);
    },
    removeEventListener(event: string, cb: EventListener) {
      const arr = listeners[event];
      if (!arr) return;
      const idx = arr.indexOf(cb);
      if (idx !== -1) arr.splice(idx, 1);
    },
    appendChild(child: any) {
      child.parentNode = element;
      this.children.push(child);
    },
    remove() {
      if (this.parentNode) {
        const arr = (this.parentNode as typeof element).children;
        const idx = arr.indexOf(this);
        if (idx !== -1) arr.splice(idx, 1);
        this.parentNode = null;
      }
      this.children.length = 0;
    },
  };
  return element as HTMLDivElement;
}

function fakeHost(): HTMLDivElement {
  return fakeElement();
}

function fakeMounted(): XtermHandle['mounted'] {
  return {
    term: {} as XtermHandle['term'],
    fit: {} as XtermHandle['fit'],
    search: {} as XtermHandle['search'],
    serialize: {} as XtermHandle['serialize'],
    onCwdChange: vi.fn(() => () => undefined),
    onTitleChange: vi.fn(() => () => undefined),
    onProgressChange: vi.fn(() => () => undefined),
    setVisible: vi.fn(),
    dispose: vi.fn(),
    jumpToPrompt: vi.fn(),
  } as unknown as XtermHandle['mounted'];
}

function createCtx(host?: HTMLDivElement): MountSessionContext {
  return {
    xterms: new Map<string, XtermHandle>(),
    pendingMounts: new Set<string>(),
    hostFor: () => host,
    xtermPrefs: {},
    handleXtermKey: () => true,
    setTabs: () => undefined,
    activeIdIn: () => null,
    activeColumn: () => 'left',
    setActiveIn: () => undefined,
    setActiveColumn: () => undefined,
    transitioningInColumn: { left: 0, right: 0 },
  };
}

describe('mountForSession', () => {
  it('does nothing when the id is already mounted', async () => {
    const ctx = createCtx();
    ctx.xterms.set('id1', { element: fakeElement() } as XtermHandle);
    await mountForSession(ctx, 'id1', 'left');
    expect(ctx.pendingMounts.size).toBe(0);
  });

  it('does nothing when the id is already pending', async () => {
    const ctx = createCtx();
    ctx.pendingMounts.add('id1');
    await mountForSession(ctx, 'id1', 'left');
    expect(ctx.pendingMounts.size).toBe(1);
  });

  it('cleans up pendingMounts and element when mountXterm throws (S2)', async () => {
    h.mountXterm.mockImplementation(() => {
      throw new Error('xterm-mount failed');
    });
    const host = fakeHost();
    const ctx = createCtx(host);
    await expect(mountForSession(ctx, 'id1', 'left')).rejects.toThrow('xterm-mount failed');
    expect(ctx.pendingMounts.has('id1')).toBe(false);
    expect(ctx.xterms.has('id1')).toBe(false);
    // The created element was appended to the host, then removed on failure.
    expect(host.children.length).toBe(0);
  });

  it('keeps the element on a successful mount and clears pendingMounts', async () => {
    h.mountXterm.mockReturnValue(fakeMounted());
    const host = fakeHost();
    const ctx = createCtx(host);
    await mountForSession(ctx, 'id1', 'left');
    expect(ctx.pendingMounts.has('id1')).toBe(false);
    expect(ctx.xterms.has('id1')).toBe(true);
    expect(host.children.length).toBe(1);
  });

  it('removes the element when a race made the mount unnecessary', async () => {
    h.mountXterm.mockReturnValue(fakeMounted());
    const host = fakeHost();
    const ctx = createCtx(host);
    // Simulate another tab with the same id being mounted while the chunk loaded.
    ctx.xterms.set('id1', { element: fakeElement() } as XtermHandle);
    await mountForSession(ctx, 'id1', 'left');
    expect(ctx.pendingMounts.has('id1')).toBe(false);
    expect(host.children.length).toBe(0);
  });
});
