import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IBufferCell, IBufferLine, ILink, Terminal } from '@xterm/xterm';
import {
  terminalDocumentLinks,
  TERMINAL_DOCUMENT_EVENT,
  TERMINAL_OPEN_PATH_EVENT,
} from './terminal-document-links';

class TestMouseEvent extends Event {
  clientX = 10;
  clientY = 5;
  button = 0;
  buttons = 1;
  shiftKey = false;
  ctrlKey = false;
  metaKey = false;
  altKey = false;
  detail = 1;
  constructor(type: string, values: Record<string, unknown> = {}) {
    super(type, { cancelable: true, bubbles: true });
    const { bubbles: _bubbles, cancelable: _cancelable, ...fields } = values;
    Object.assign(this, fields);
  }
}
class TestCustomEvent extends Event {
  detail: unknown;
  constructor(type: string, init: { detail: unknown }) {
    super(type);
    this.detail = init.detail;
  }
}

const disposals: (() => void)[] = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

interface FakeCellData {
  chars: string;
  width: number;
}

/** Minimal buffer pieces for the path provider: blanks stay width 1 with no
 *  chars, exactly like a real buffer row. */
function pathCells(text: string): FakeCellData[] {
  return [...text].map((character) => ({ chars: character, width: 1 }));
}

class PathLine implements IBufferLine {
  constructor(private readonly cells: FakeCellData[]) {}
  get length(): number {
    return this.cells.length;
  }
  readonly isWrapped = false;
  getCell(x: number): IBufferCell | undefined {
    const data = this.cells[x];
    if (!data) return undefined;
    return {
      getChars: () => data.chars,
      getWidth: () => data.width,
    } as unknown as IBufferCell;
  }
  translateToString(): string {
    return this.cells.map((cell) => cell.chars || ' ').join('');
  }
}

function setup() {
  const window = Object.assign(new EventTarget(), {
    condash: { openExternal: vi.fn(), termPathExists: async () => true },
  });
  vi.stubGlobal('window', window);
  vi.stubGlobal('MouseEvent', TestMouseEvent);
  vi.stubGlobal('CustomEvent', TestCustomEvent);
  const host = new EventTarget();
  const hooks = new Map<string, () => void>();
  const hook = (kind: string) => (callback: () => void) => {
    hooks.set(kind, callback);
    return { dispose: () => hooks.delete(kind) };
  };
  // One paintable buffer row the path provider can scan: y 6 reads row index 5.
  const pathRow = { cells: pathCells('/tmp/shot.png'), isWrapped: false };
  const term = {
    element: {
      querySelector: () => ({
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 80, height: 24 }),
      }),
    },
    cols: 80,
    rows: 24,
    modes: { mouseTrackingMode: 'vt200' },
    buffer: {
      active: {
        viewportY: 0,
        getLine: (index: number) => (index === 5 ? new PathLine(pathRow.cells) : null),
      },
    },
    focus: vi.fn(),
    onResize: hook('resize'),
    onScroll: hook('scroll'),
  } as unknown as Terminal;
  const links = terminalDocumentLinks(term, host as HTMLElement, 'terminal-fixture');
  disposals.push(links.dispose);
  const opened = vi.fn();
  window.addEventListener(TERMINAL_DOCUMENT_EVENT, opened);
  const pathOpened = vi.fn();
  window.addEventListener(TERMINAL_OPEN_PATH_EVENT, pathOpened);
  const downReports = vi.fn();
  host.addEventListener('mousedown', downReports);
  const hover = (uri = 'guide.md') =>
    links.handler.hover!(new TestMouseEvent('mousemove') as unknown as MouseEvent, uri, {
      start: { x: 1, y: 6 },
      end: { x: 40, y: 6 },
    });
  const down = (values = {}) => host.dispatchEvent(new TestMouseEvent('mousedown', values));
  const up = (values = {}) => window.dispatchEvent(new TestMouseEvent('mouseup', values));
  const move = (values = {}) => window.dispatchEvent(new TestMouseEvent('mousemove', values));
  /** Repaint the buffer row, run the path provider, and feed its link into the
   *  gate like xterm's Linkifier hover would. */
  const hoverPath = async (text: string): Promise<ILink> => {
    pathRow.cells = pathCells(text);
    const provided = await new Promise<ILink[] | undefined>((resolve) =>
      links.pathProvider.provideLinks(6, resolve),
    );
    if (!provided || provided.length === 0) throw new Error(`No path link provided for ${text}`);
    provided[0].hover!(
      new TestMouseEvent('mousemove') as unknown as MouseEvent,
      provided[0].text as string,
    );
    return provided[0];
  };
  return {
    window,
    host,
    term,
    links,
    opened,
    pathOpened,
    downReports,
    hover,
    down,
    up,
    move,
    hoverPath,
    hooks,
  };
}

describe('terminal document gesture ownership', () => {
  it('consumes both local click edges before PTY handlers and activates once', () => {
    const s = setup();
    s.hover();
    expect(s.down()).toBe(false);
    expect(s.up()).toBe(false);
    expect(s.downReports).not.toHaveBeenCalled();
    expect(s.opened).toHaveBeenCalledTimes(1);
    expect((s.opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'terminal-fixture',
      uri: 'guide.md',
    });
    s.up();
    expect(s.opened).toHaveBeenCalledTimes(1);
  });

  it('hands a drag its original down, without link activation', () => {
    const s = setup();
    s.hover();
    s.down();
    s.move({ clientX: 20 });
    s.move({ clientX: 25 });
    expect(s.downReports).toHaveBeenCalledTimes(1);
    expect((s.downReports.mock.calls[0][0] as MouseEvent).clientX).toBe(10);
    expect(s.up({ clientX: 25 })).toBe(true);
    expect(s.opened).not.toHaveBeenCalled();
    s.links.handler.activate(new TestMouseEvent('mouseup') as unknown as MouseEvent, 'guide.md', {
      start: { x: 1, y: 6 },
      end: { x: 40, y: 6 },
    });
    expect(s.opened).not.toHaveBeenCalled();
  });

  it('keeps an owned click across leave/hover renewal of the same URI and range', () => {
    const s = setup();
    s.hover();
    s.down();
    s.links.handler.leave!(new TestMouseEvent('mousemove') as unknown as MouseEvent, 'guide.md', {
      start: { x: 1, y: 6 },
      end: { x: 40, y: 6 },
    });
    s.hover();
    expect(s.up()).toBe(false);
    expect(s.opened).toHaveBeenCalledTimes(1);
    expect(s.downReports).not.toHaveBeenCalled();
  });

  it('cancels when a renewed target changes URI or range, including a mutated range object', () => {
    const s = setup();
    s.hover();
    s.down();
    s.hover('other.md');
    s.up();
    const range = { start: { x: 1, y: 6 }, end: { x: 40, y: 6 } };
    s.links.handler.hover!(
      new TestMouseEvent('mousemove') as unknown as MouseEvent,
      'guide.md',
      range,
    );
    s.down();
    range.end.x = 30;
    s.links.handler.hover!(
      new TestMouseEvent('mousemove') as unknown as MouseEvent,
      'guide.md',
      range,
    );
    s.up();
    expect(s.opened).not.toHaveBeenCalled();
    expect(s.downReports).not.toHaveBeenCalled();
  });

  it('retains same-cell hover after blur while cancelling a gesture already in progress', () => {
    const s = setup();
    s.hover();
    s.down();
    s.window.dispatchEvent(new Event('blur'));
    s.up();
    expect(s.opened).not.toHaveBeenCalled();
    expect(s.down()).toBe(false);
    expect(s.up()).toBe(false);
    expect(s.opened).toHaveBeenCalledTimes(1);
    expect(s.downReports).not.toHaveBeenCalled();
  });

  it('leaves Shift-selection, non-left clicks, web and unsupported targets alone', () => {
    const s = setup();
    s.hover();
    expect(s.down({ shiftKey: true })).toBe(true);
    expect(s.down({ button: 2 })).toBe(true);
    s.hover('https://example.com');
    expect(s.down()).toBe(true);
    s.hover('javascript:guide.md');
    expect(s.down()).toBe(true);
    expect(s.opened).not.toHaveBeenCalled();
    expect(s.downReports).toHaveBeenCalledTimes(4);
  });

  it('cancels outside releases, changed links, scrolling and focus departure', () => {
    const s = setup();
    s.hover();
    s.down();
    s.up({ clientY: 10 });
    s.hover();
    s.down();
    s.hover('other.mdx');
    s.up();
    s.hover();
    s.down();
    s.hooks.get('scroll')!();
    s.up();
    s.hover();
    s.down();
    s.window.dispatchEvent(new Event('blur'));
    s.up();
    expect(s.opened).not.toHaveBeenCalled();
  });

  it('handles a wrapped range using the public viewport offset', () => {
    const s = setup();
    s.links.handler.hover!(
      new TestMouseEvent('mousemove') as unknown as MouseEvent,
      'decision.mdx',
      { start: { x: 70, y: 5 }, end: { x: 20, y: 6 } },
    );
    s.down();
    s.up();
    expect(s.opened).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a mouse-reporting TUI web opener, retaining modified and ordinary shell links', () => {
    const s = setup();
    const range = { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } };
    s.links.handler.activate(
      new TestMouseEvent('mouseup') as unknown as MouseEvent,
      'https://example.com',
      range,
    );
    expect(s.window.condash.openExternal).not.toHaveBeenCalled();
    s.links.handler.activate(
      new TestMouseEvent('mouseup', { ctrlKey: true }) as unknown as MouseEvent,
      'https://example.com',
      range,
    );
    expect(s.window.condash.openExternal).not.toHaveBeenCalled();
    (s.term.modes as { mouseTrackingMode: string }).mouseTrackingMode = 'none';
    s.links.handler.activate(
      new TestMouseEvent('mouseup') as unknown as MouseEvent,
      'https://example.com',
      range,
    );
    expect(s.window.condash.openExternal).toHaveBeenCalledTimes(1);
  });

  for (const uri of ['https://example.com', 'HTTP://example.com', 'mailto:test@example.com']) {
    for (const modifier of [
      { ctrlKey: true },
      { metaKey: true },
      { ctrlKey: true, altKey: true },
    ]) {
      it(`owns reporting-mode ${uri} with ${JSON.stringify(modifier)} once before both edges`, () => {
        const s = setup();
        s.hover(uri);
        expect(s.down(modifier)).toBe(false);
        expect(s.up(modifier)).toBe(false);
        expect(s.downReports).not.toHaveBeenCalled();
        expect(s.opened).not.toHaveBeenCalled();
        expect(s.window.condash.openExternal).toHaveBeenCalledTimes(1);
        expect(s.window.condash.openExternal).toHaveBeenCalledWith(uri);
        s.links.handler.activate(
          new TestMouseEvent('mouseup', modifier) as unknown as MouseEvent,
          uri,
          {
            start: { x: 1, y: 6 },
            end: { x: 40, y: 6 },
          },
        );
        expect(s.window.condash.openExternal).toHaveBeenCalledTimes(1);
      });
    }
  }

  it('does not capture non-reporting web, Alt-only, Shift combinations or unsafe schemes', () => {
    const s = setup();
    s.hover('https://example.com');
    for (const modifier of [
      {},
      { altKey: true },
      { ctrlKey: true, shiftKey: true },
      { metaKey: true, shiftKey: true },
    ]) {
      expect(s.down(modifier)).toBe(true);
      s.up(modifier);
    }
    (s.term.modes as { mouseTrackingMode: string }).mouseTrackingMode = 'none';
    expect(s.down({ ctrlKey: true })).toBe(true);
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,test',
      'httpsx://example.com',
      'file:///tmp/test.html',
    ]) {
      s.hover(uri);
      expect(s.down({ ctrlKey: true })).toBe(true);
      s.links.handler.activate(new TestMouseEvent('mouseup') as unknown as MouseEvent, uri, {
        start: { x: 1, y: 6 },
        end: { x: 40, y: 6 },
      });
    }
    expect(s.window.condash.openExternal).not.toHaveBeenCalled();
  });

  it('replays a modified web drag but never activates it through Linkifier', () => {
    const s = setup();
    s.hover('https://example.com');
    s.down({ metaKey: true });
    s.move({ clientX: 20, metaKey: true });
    s.up({ clientX: 20, metaKey: true });
    expect(s.downReports).toHaveBeenCalledTimes(1);
    expect((s.downReports.mock.calls[0][0] as MouseEvent).metaKey).toBe(true);
    s.links.handler.activate(
      new TestMouseEvent('mouseup', { metaKey: true }) as unknown as MouseEvent,
      'https://example.com',
      {
        start: { x: 1, y: 6 },
        end: { x: 40, y: 6 },
      },
    );
    expect(s.window.condash.openExternal).not.toHaveBeenCalled();
  });

  it('cancels pending web ownership on resize, scroll, disposal and Shift release', () => {
    const s = setup();
    for (const hook of ['resize', 'scroll']) {
      s.hover('https://example.com');
      s.down({ ctrlKey: true });
      s.hooks.get(hook)!();
      s.up({ ctrlKey: true });
    }
    s.hover('https://example.com');
    s.down({ ctrlKey: true });
    s.up({ ctrlKey: true, shiftKey: true });
    s.down({ ctrlKey: true });
    s.links.dispose();
    s.up({ ctrlKey: true });
    expect(s.window.condash.openExternal).not.toHaveBeenCalled();
    expect(s.hooks.size).toBe(0);
  });

  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    for (const scenario of ['drag-release-alt', 'drag-mode-off', 'blur-mode-off']) {
      it(`retains ${JSON.stringify(modifier)} capture through ${scenario} and resets on genuine downs`, () => {
        const s = setup();
        const uri = 'https://example.com';
        const range = { start: { x: 1, y: 6 }, end: { x: 40, y: 6 } };
        const activate = (values = {}) =>
          s.links.handler.activate(
            new TestMouseEvent('mouseup', values) as unknown as MouseEvent,
            uri,
            range,
          );
        s.hover(uri);
        s.down(modifier);
        if (scenario.startsWith('drag')) s.move({ clientX: 20 });
        else s.window.dispatchEvent(new Event('blur'));
        if (scenario.endsWith('mode-off')) {
          (s.term.modes as { mouseTrackingMode: string }).mouseTrackingMode = 'none';
        }
        const release = scenario === 'drag-release-alt' ? { altKey: true } : modifier;
        s.up({ ...release, clientX: 20 });
        activate(release);
        expect(s.window.condash.openExternal).not.toHaveBeenCalled();

        (s.term.modes as { mouseTrackingMode: string }).mouseTrackingMode = 'vt200';
        expect(s.down({ altKey: true })).toBe(true);
        s.up({ altKey: true });
        activate({ altKey: true });
        expect(s.window.condash.openExternal).toHaveBeenCalledTimes(1);
        (s.term.modes as { mouseTrackingMode: string }).mouseTrackingMode = 'none';
        expect(s.down()).toBe(true);
        s.up();
        activate();
        expect(s.window.condash.openExternal).toHaveBeenCalledTimes(2);
      });
    }
  }
});

describe('plain path link gestures', () => {
  it('owns both edges of a click on a .md path and opens the document event', async () => {
    const s = setup();
    const link = await s.hoverPath('/tmp/note.md');
    expect(s.down()).toBe(false);
    expect(s.up()).toBe(false);
    expect(s.downReports).not.toHaveBeenCalled();
    expect(s.opened).toHaveBeenCalledTimes(1);
    expect((s.opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'terminal-fixture',
      uri: '/tmp/note.md',
    });
    expect(s.pathOpened).not.toHaveBeenCalled();
    // Local document activation belongs exclusively to the capture gate.
    link.activate(new TestMouseEvent('mouseup') as unknown as MouseEvent, link.text as string);
    expect(s.opened).toHaveBeenCalledTimes(1);
  });

  it('leaves a non-document path plain click to the Linkifier and opens through the open-path event', async () => {
    const s = setup();
    const link = await s.hoverPath('/tmp/shot.png');
    expect(s.down()).toBe(true);
    expect(s.up()).toBe(true);
    expect(s.downReports).toHaveBeenCalledTimes(1);
    expect(s.opened).not.toHaveBeenCalled();
    link.activate(new TestMouseEvent('mouseup') as unknown as MouseEvent, link.text as string);
    expect(s.pathOpened).toHaveBeenCalledTimes(1);
    expect((s.pathOpened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      path: '/tmp/shot.png',
    });
    expect(s.opened).not.toHaveBeenCalled();
    expect(s.window.condash.openExternal).not.toHaveBeenCalled();
  });

  it('owns Ctrl- and Meta-clicks on a non-document path before both PTY edges', async () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const s = setup();
      await s.hoverPath('/tmp/shot.png');
      expect(s.down(modifier)).toBe(false);
      expect(s.up(modifier)).toBe(false);
      expect(s.downReports).not.toHaveBeenCalled();
      expect(s.pathOpened).toHaveBeenCalledTimes(1);
      expect((s.pathOpened.mock.calls[0][0] as CustomEvent).detail).toEqual({
        path: '/tmp/shot.png',
      });
    }
  });

  it('keeps Shift-selection and unsupported tokens terminal-owned', async () => {
    const s = setup();
    await s.hoverPath('/tmp/shot.png');
    expect(s.down({ shiftKey: true })).toBe(true);
    s.up({ shiftKey: true });
    expect(s.pathOpened).not.toHaveBeenCalled();
    // A token the provider refuses (no candidate) never enters the gate.
    await expect(s.hoverPath('no path here')).rejects.toThrow('No path link provided');
    expect(s.pathOpened).not.toHaveBeenCalled();
    expect(s.opened).not.toHaveBeenCalled();
  });
});
