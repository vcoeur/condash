import { describe, expect, it, vi } from 'vitest';
import type { IBufferCell, IBufferLine, IBufferRange, ILink, Terminal } from '@xterm/xterm';
import { createTerminalPathLinkProvider, type TerminalPathLinkHooks } from './terminal-path-links';

interface FakeCellData {
  chars: string;
  width: number;
}

class FakeCell {
  constructor(private readonly data: FakeCellData) {}
  getChars(): string {
    return this.data.chars;
  }
  getWidth(): number {
    return this.data.width;
  }
}

class FakeLine implements IBufferLine {
  readonly isWrapped: boolean;
  constructor(
    private readonly cells: FakeCellData[],
    isWrapped: boolean = false,
  ) {
    this.isWrapped = isWrapped;
  }
  get length(): number {
    return this.cells.length;
  }
  getCell(x: number): IBufferCell | undefined {
    const data = this.cells[x];
    if (!data) return undefined;
    return new FakeCell(data) as unknown as IBufferCell;
  }
  translateToString(_trimRight?: boolean, _startColumn?: number, _endColumn?: number): string {
    return this.cells.map((cell) => cell.chars || ' ').join('');
  }
}

/** Real buffer cells: blanks are chars='' width=1, a wide char owns its cell
 *  plus a zero-width continuation cell. */
function rowOf(text: string): FakeCellData[] {
  const cells: FakeCellData[] = [];
  for (const character of text) {
    if (isWide(character)) cells.push({ chars: character, width: 2 }, { chars: '', width: 0 });
    else cells.push({ chars: character, width: 1 });
  }
  return cells;
}

function isWide(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf));
}

function blank(count: number): FakeCellData[] {
  return Array.from({ length: count }, () => ({ chars: '', width: 1 }));
}

function makeTerm(rows: { cells: FakeCellData[]; isWrapped?: boolean }[]): Terminal {
  const lines = rows.map(({ cells, isWrapped }) => new FakeLine(cells, isWrapped ?? false));
  return {
    buffer: {
      active: {
        getLine: (index: number) => lines[index] ?? null,
      },
    },
  } as unknown as Terminal;
}

interface Hooks {
  hovered: { uri: string; range: IBufferRange }[];
  opened: string[];
  left: number;
}

function makeHooks(): { hooks: TerminalPathLinkHooks; state: Hooks } {
  const state: Hooks = { hovered: [], opened: [], left: 0 };
  return {
    state,
    hooks: {
      hover: (uri, range) => state.hovered.push({ uri, range }),
      leave: () => state.left++,
      openPath: (path) => state.opened.push(path),
    },
  };
}

function provideLinks(
  term: Terminal,
  hooks: TerminalPathLinkHooks,
  probe: (path: string) => Promise<boolean>,
): (y: number) => Promise<ILink[] | undefined> {
  const { provider } = createTerminalPathLinkProvider(term, hooks, probe);
  return (y: number) =>
    new Promise((resolve) => {
      provider.provideLinks(y, resolve);
    });
}

describe('terminal plain-path link provider', () => {
  it('provides an existing single-line path with a 1-based range', async () => {
    const term = makeTerm([{ cells: [...rowOf('Note: '), ...rowOf('/tmp/guide.md')] }]);
    const { hooks, state } = makeHooks();
    const probe = vi.fn(async (path: string) => path === '/tmp/guide.md');
    const provide = provideLinks(term, hooks, probe);
    const links = await provide(1);
    expect(probe).toHaveBeenCalledWith('/tmp/guide.md');
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe('/tmp/guide.md');
    expect(links![0].range).toEqual({ start: { x: 7, y: 1 }, end: { x: 19, y: 1 } });
    links![0].hover!({} as MouseEvent, links![0].text!);
    expect(state.hovered[0].uri).toBe('/tmp/guide.md');
    links![0].activate({} as MouseEvent, links![0].text!);
    // A .md document belongs to the capture gate; never opens directly.
    expect(state.opened).toEqual([]);
    links![0].leave!({} as MouseEvent, links![0].text!);
    expect(state.left).toBe(1);
  });

  it('opens an existing non-document path through the open-path hook', async () => {
    const term = makeTerm([{ cells: rowOf('shot: /tmp/shot.png') }]);
    const { hooks, state } = makeHooks();
    const provide = provideLinks(term, hooks, async (path) => path === '/tmp/shot.png');
    const links = await provide(1);
    links![0].activate({} as MouseEvent, links![0].text!);
    expect(state.opened).toEqual(['/tmp/shot.png']);
  });

  it('skips paths that do not exist', async () => {
    const term = makeTerm([{ cells: rowOf('later: /tmp/missing.md') }]);
    const { hooks } = makeHooks();
    const probe = vi.fn(async () => false);
    const provide = provideLinks(term, hooks, probe);
    expect(await provide(1)).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('stops a token at the first whitespace', async () => {
    const term = makeTerm([{ cells: rowOf('/tmp/spaced name.md') }]);
    const { hooks } = makeHooks();
    const probe = vi.fn(async (path: string) => path === '/tmp/spaced');
    const provide = provideLinks(term, hooks, probe);
    const links = await provide(1);
    expect(probe).toHaveBeenCalledWith('/tmp/spaced');
    expect(links![0].text).toBe('/tmp/spaced');
    expect(links![0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 11, y: 1 } });
  });

  it('rejects a slash hugging a non-whitespace character', async () => {
    const term = makeTerm([{ cells: rowOf('see https://example.com/docs and x/tmp/file.md') }]);
    const { hooks } = makeHooks();
    const probe = vi.fn(async () => true);
    const provide = provideLinks(term, hooks, probe);
    expect(await provide(1)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('joins a wrapped path and yields the same full range from any covered row', async () => {
    const term = makeTerm([
      { cells: rowOf('/tmp/very/long/') },
      { cells: rowOf('path/guide.md'), isWrapped: true },
    ]);
    const { hooks } = makeHooks();
    const probe = vi.fn(async (path: string) => path === '/tmp/very/long/path/guide.md');
    const provide = provideLinks(term, hooks, probe);
    const fromFirst = await provide(1);
    const fromSecond = await provide(2);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fromFirst![0].text).toBe('/tmp/very/long/path/guide.md');
    expect(fromFirst![0].range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 13, y: 2 },
    });
    expect(fromSecond![0].range).toEqual(fromFirst![0].range);
  });

  it('maps wide characters so the range covers both cells', async () => {
    const term = makeTerm([{ cells: [...rowOf('/tmp/'), ...rowOf('筆記.md')] }]);
    const { hooks } = makeHooks();
    const provide = provideLinks(term, hooks, async (path) => path === '/tmp/筆記.md');
    const links = await provide(1);
    expect(links![0].text).toBe('/tmp/筆記.md');
    // '/tmp/' is 5 cells, 筆 occupies columns 6-7, 記 8-9, '.' 10, 'm' 11, 'd' 12.
    expect(links![0].range).toEqual({ start: { x: 1, y: 1 }, end: { x: 12, y: 1 } });
  });

  it('caches a probe within its TTL and dedupes concurrent probes', async () => {
    const term = makeTerm([{ cells: rowOf('/tmp/guide.md') }]);
    const { hooks } = makeHooks();
    let resolveProbe!: (value: boolean) => void;
    const probe = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveProbe = resolve)) as Promise<boolean>,
    );
    const provide = provideLinks(term, hooks, probe);
    const first = provide(1);
    const second = provide(1);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);
    resolveProbe(true);
    expect((await first)![0].text).toBe('/tmp/guide.md');
    expect((await second)![0].text).toBe('/tmp/guide.md');
    const third = await provide(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(third![0].text).toBe('/tmp/guide.md');
  });

  it('caps concurrent probes and queues the rest', async () => {
    const cells = blank(1);
    for (let index = 0; index < 10; index++) {
      cells.push(...rowOf(`/tmp/p${index}.md `));
    }
    const term = makeTerm([{ cells }]);
    const { hooks } = makeHooks();
    const resolvers: ((value: boolean) => void)[] = [];
    const probe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvers.push(resolve);
        }) as Promise<boolean>,
    );
    const provide = provideLinks(term, hooks, probe);
    const pending = provide(1);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(8);
    for (const resolve of resolvers.splice(0)) resolve(true);
    await expect.poll(() => probe.mock.calls.length, { interval: 10 }).toBe(10);
    for (const resolve of resolvers.splice(0)) resolve(true);
    const links = await pending;
    expect(links).toHaveLength(10);
  });

  it('answers nothing for a missing row without probing', async () => {
    const term = makeTerm([]);
    const { hooks } = makeHooks();
    const probe = vi.fn(async () => true);
    const provide = provideLinks(term, hooks, probe);
    expect(await provide(4)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
