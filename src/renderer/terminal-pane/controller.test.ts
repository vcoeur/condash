/**
 * Wiring tests for the terminal-pane controller — the layer the pure modules
 * cannot reach.
 *
 * `fit-when-ready`, `nudge-machine`, `visibility-plan` and `transition-buffers`
 * are pure and well covered, but every defect in the "tab is stale until I hit
 * Refresh" class has lived in the CONTROLLER: which decision is called, with
 * what, in what order, and how many times. A review of the first cut of these
 * fixes reverted two of them — the atomic active-id write and the transition
 * buffer's delivery report — and the whole terminal-pane suite stayed green,
 * because the tests called the extracted helpers directly. That is the failure
 * mode this bug class has repeated for seven prior fixes: mechanisms pinned,
 * wiring untested.
 *
 * So these tests run the real `createTerminalController` and fake only what it
 * reaches out to: the IPC bridge, the xterm module, the worker thread, rAF,
 * ResizeObserver and localStorage. rAF is routed through `setTimeout` so
 * Vitest's `advanceTimersByTimeAsync` drives the controller's promise chains
 * (`visibilityChain`) as well as the nudge's 160 ms hold.
 *
 * Each test names the fix it pins and must go RED when that fix is reverted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import type { Column } from './types';

// ---------------------------------------------------------------- fake xterm

interface FakeTerm {
  cols: number;
  rows: number;
  buffer: { active: { type: 'normal' | 'alternate' } };
  options: { scrollback: number };
  resizes: [number, number][];
  writes: string[];
  disposed: boolean;
  resize(cols: number, rows: number): void;
  write(data: string): void;
  focus(): void;
  onResize(cb: (size: { cols: number; rows: number }) => void): void;
}

/** Geometry the fake host + fit addon report this frame. */
const geometry = {
  clientWidth: 1200,
  clientHeight: 400,
  propose: { cols: 200, rows: 50 } as { cols: number; rows: number } | undefined,
};

let bufferType: 'normal' | 'alternate' = 'normal';
let mountedTerms: { id: string; term: FakeTerm; geometry?: { cols: number; rows: number } }[] = [];
/** The pty's winsize as main reports it over `termGeometry`, or null when the
 *  verb is unavailable (an older preload). */
let ptyGeometry: { cols: number; rows: number } | null = null;
/** Session whose next mount must fail (a thrown dynamic import / mount). */
let failMountFor: string | null = null;
/** Every (id, cols, rows) the renderer pushed to the pty over IPC. */
let ptyResizes: [string, number, number][] = [];

function makeTerm(id: string): FakeTerm {
  const listeners: ((size: { cols: number; rows: number }) => void)[] = [];
  const term: FakeTerm = {
    cols: 80,
    rows: 24,
    buffer: {
      active: {
        get type() {
          return bufferType;
        },
      },
    } as FakeTerm['buffer'],
    options: { scrollback: 5000 },
    resizes: [],
    writes: [],
    disposed: false,
    resize(cols, rows) {
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      this.resizes.push([cols, rows]);
      // Mirrors xterm: onResize → termResize IPC → pty.resize.
      for (const cb of listeners) cb({ cols, rows });
    },
    write(data) {
      this.writes.push(data);
    },
    focus() {},
    onResize(cb) {
      listeners.push(cb);
    },
  };
  term.onResize(({ cols, rows }) => ptyResizes.push([id, cols, rows]));
  return term;
}

const h = vi.hoisted(() => ({ mountXterm: vi.fn() }));

vi.mock('../xterm-mount', () => ({ mountXterm: h.mountXterm }));

/** Worker stand-in: records the geometry each headless Terminal was made at. */
const workerTerms = new Map<string, { cols: number; rows: number; writes: string[] }>();
let heldSerialize: { release: (snapshot?: string) => void } | null = null;

vi.mock('../terminal-worker-manager', () => ({
  TerminalWorkerManager: class {
    create(id: string, cols: number, rows: number) {
      workerTerms.set(id, { cols, rows, writes: [] });
      return Promise.resolve('');
    }
    write(id: string, data: string) {
      workerTerms.get(id)?.writes.push(data);
    }
    serialize(id: string) {
      if (heldSerialize) {
        const held = heldSerialize;
        heldSerialize = null;
        return new Promise<string>((resolve) => {
          held.release = (snapshot = `<snapshot ${id}>`) => resolve(snapshot);
        });
      }
      return Promise.resolve(`<snapshot ${id}>`);
    }
    dispose(id: string) {
      workerTerms.delete(id);
      return Promise.resolve('');
    }
    terminate() {}
  },
}));

// ------------------------------------------------------------- fake DOM/IPC

function fakeElement(): HTMLDivElement {
  const element = {
    className: '',
    style: {} as CSSStyleDeclaration,
    parentNode: null as unknown,
    children: [] as unknown[],
    get clientWidth() {
      return geometry.clientWidth;
    },
    get clientHeight() {
      return geometry.clientHeight;
    },
    addEventListener() {},
    removeEventListener() {},
    hasAttribute: () => false,
    appendChild(child: { parentNode: unknown }) {
      child.parentNode = element;
      element.children.push(child);
    },
    remove() {
      element.parentNode = null;
    },
  };
  return element as unknown as HTMLDivElement;
}

type SessionListener = (snap: { id: string; side: 'my'; exited?: number }[]) => void;
type DataListener = (event: { id: string; data: string }) => void;

let sessionListener: SessionListener | null = null;
let dataListener: DataListener | null = null;

function installGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: () => fakeElement(),
    body: { hasAttribute: () => false },
    documentElement: { style: { setProperty() {} } },
  };
  g.window = {
    addEventListener() {},
    removeEventListener() {},
    condash: {
      onTermSessions: (cb: SessionListener) => {
        sessionListener = cb;
        return () => (sessionListener = null);
      },
      onTermData: (cb: DataListener) => {
        dataListener = cb;
        return () => (dataListener = null);
      },
      onTermExit: () => () => undefined,
      onDashboardTabSummaries: () => () => undefined,
      dashboardGetState: () => Promise.resolve(null),
      termList: () => Promise.resolve([]),
      termAttach: (id: string) => Promise.resolve({ output: `<attach ${id}>` }),
      termGeometry: () => Promise.resolve(ptyGeometry),
      termResize: (id: string, cols: number, rows: number) => {
        ptyResizes.push([id, cols, rows]);
        return Promise.resolve();
      },
      termWrite: () => Promise.resolve(),
      termClose: () => Promise.resolve(),
      termSpawn: () => Promise.resolve({ id: 'x' }),
    },
    localStorage: undefined,
  };
  g.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  (g.window as Record<string, unknown>).localStorage = g.localStorage;
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // rAF over setTimeout so fake timers drive the fit retries and the promise
  // chain the nudge hangs off.
  g.requestAnimationFrame = (cb: (t: number) => void) =>
    setTimeout(() => cb(0), 16) as unknown as number;
  g.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
}

// --------------------------------------------------------------- the harness

interface Harness {
  sessions(ids: string[]): void;
  data(id: string, chunk: string): void;
  term(id: string): FakeTerm | undefined;
  activeIdWrites: { left: string | null; right: string | null }[];
  controller: {
    activeIdIn(col: Column): string | null;
    setActiveIn(col: Column, id: string | null): void;
    refreshSession(id: string | null, opts?: { onlyIfAltBuffer?: boolean; auto?: boolean }): void;
    registerHost(col: Column, el: HTMLDivElement): void;
  };
  setOpen(open: boolean): void;
  setBottomView(view: 'terminal' | 'dashboard'): void;
  touchLayout(): void;
  dispose(): void;
}

async function createHarness(opts: { autoRefreshOnTabSwitch?: boolean } = {}): Promise<Harness> {
  const { createSignal, createEffect } = await import('solid-js');
  const { createTerminalController } = await import('./controller');

  let harness!: Harness;
  const dispose = createRoot((disposeRoot) => {
    const [open, setOpen] = createSignal(true);
    const [bottomView, setBottomView] = createSignal<'terminal' | 'dashboard'>('terminal');
    // `equals: false` reproduces the real prop: `layout` is a memo over an object
    // `updateLayout` reallocates on every patch, so the effect re-runs even when
    // the boolean it reads is unchanged.
    const [layoutTick, setLayoutTick] = createSignal(0, { equals: false });

    const props = {
      get open() {
        layoutTick();
        return open();
      },
      onClose: () => {},
      get bottomView() {
        layoutTick();
        return bottomView();
      },
      onSelectBand: () => {},
      onShowTerminalBand: () => {},
      registerHandle: () => {},
      agents: [],
      autoRefreshOnTabSwitch: opts.autoRefreshOnTabSwitch,
    };

    const controller = createTerminalController(
      props as unknown as Parameters<typeof createTerminalController>[0],
    );

    const activeIdWrites: { left: string | null; right: string | null }[] = [];
    createEffect(() => {
      activeIdWrites.push({
        left: controller.activeIdIn('left'),
        right: controller.activeIdIn('right'),
      });
    });

    controller.registerHost('left', fakeElement());
    controller.registerHost('right', fakeElement());

    harness = {
      sessions: (ids) => sessionListener?.(ids.map((id) => ({ id, side: 'my' as const }))),
      data: (id, chunk) => dataListener?.({ id, data: chunk }),
      term: (id) => mountedTerms.filter((m) => m.id === id).at(-1)?.term,
      activeIdWrites,
      controller,
      setOpen,
      setBottomView,
      touchLayout: () => setLayoutTick((n) => n + 1),
      dispose: disposeRoot,
    };
    return disposeRoot;
  });
  void dispose;
  return harness;
}

/** Let every queued microtask, rAF and timer run — the controller's work is
 *  spread across `visibilityChain`, `queueMicrotask` and two timers. */
async function settle(ms = 600): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  installGlobals();
  mountedTerms = [];
  ptyResizes = [];
  workerTerms.clear();
  heldSerialize = null;
  failMountFor = null;
  ptyGeometry = null;
  bufferType = 'normal';
  geometry.clientWidth = 1200;
  geometry.clientHeight = 400;
  geometry.propose = { cols: 200, rows: 50 };
  h.mountXterm.mockReset();
  h.mountXterm.mockImplementation(
    (
      _el: unknown,
      id: string,
      options: { replay?: string; geometry?: { cols: number; rows: number } },
    ) => {
      if (failMountFor === id) {
        failMountFor = null;
        throw new Error('mount failed');
      }
      const term = makeTerm(id);
      // Mirrors xterm: the constructor takes the grid, so the replay below is
      // parsed at it. Not a resize — nothing is committed to the pty.
      if (options.geometry) {
        term.cols = options.geometry.cols;
        term.rows = options.geometry.rows;
      }
      if (options.replay) term.write(options.replay);
      mountedTerms.push({ id, term, geometry: options.geometry });
      return {
        term,
        fit: {
          proposeDimensions: () => geometry.propose,
          // Mirrors FitAddon.fit(): it re-reads proposeDimensions and commits it.
          fit: () => {
            const dims = geometry.propose;
            if (dims) term.resize(dims.cols, dims.rows);
          },
        },
        search: {},
        serialize: { serialize: () => `<serialized ${id}>` },
        onCwdChange: () => () => undefined,
        onTitleChange: () => () => undefined,
        onProgressChange: () => () => undefined,
        setVisible: () => {},
        dispose: () => {
          term.disposed = true;
        },
        jumpToPrompt: () => {},
      };
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

// ----------------------------------------------------------------- the tests

describe('controller: closing the active tab (O3a — atomic active-id write)', () => {
  it('never publishes a column with no active tab', async () => {
    const harness = await createHarness();
    harness.sessions(['a', 'b']);
    await settle();
    expect(harness.controller.activeIdIn('left')).toBe('b');

    const writesBefore = harness.activeIdWrites.length;
    // 'b' (the active tab) leaves the snapshot — a user close, or the automatic
    // close on a clean exit.
    harness.sessions(['a']);
    await settle();

    const afterClose = harness.activeIdWrites.slice(writesBefore);
    expect(harness.controller.activeIdIn('left')).toBe('a');
    // The property: no observer of the signal ever sees "this column has no
    // active tab". Nulling the dropped id and then writing the fallback made
    // that phantom state public, and the switch detector read it as
    // previous-null — the tab that took over hydrated with no repaint.
    expect(afterClose.map((w) => w.left)).not.toContain(null);
    expect(afterClose.length).toBe(1);
  });

  it('repaints the tab that takes over', async () => {
    const harness = await createHarness();
    harness.sessions(['a', 'b']);
    await settle();
    const promoted = () => harness.term('a');
    const before = promoted()?.resizes.length ?? 0;

    harness.sessions(['a']);
    await settle();

    // The neighbour is mounted and was nudged: a one-row dip, then a restore.
    const resizes = promoted()!.resizes.slice(before);
    expect(resizes.some(([, rows]) => rows === geometry.propose!.rows - 1)).toBe(true);
  });
});

describe('controller: the fit never commits the clamp floor (O1)', () => {
  it('sends no 2×1 resize to the pty when the host is rendered but zero-height', async () => {
    const harness = await createHarness();
    // A rendered-but-unlaid-out host: `proposeDimensions` CLAMPS rather than
    // failing, so it answers with a perfectly finite 2×1.
    geometry.clientHeight = 0;
    geometry.propose = { cols: 2, rows: 1 };

    harness.sessions(['a']);
    await settle();

    expect(ptyResizes.filter(([, cols, rows]) => cols === 2 && rows === 1)).toEqual([]);
    // And the grid was left at the constructor default rather than committed to
    // the floor — which is what keeps the repaint enabled (`rows > 1`).
    expect(harness.term('a')!.rows).toBe(24);
  });

  it('fits normally once the host resolves a real box', async () => {
    const harness = await createHarness();
    harness.sessions(['a']);
    await settle();
    expect(harness.term('a')!.cols).toBe(200);
  });
});

describe('controller: bulk restore (F1 — one repaint, no demote mid-nudge)', () => {
  it('nudges once for a restore of several tabs, not once per tab', async () => {
    const harness = await createHarness();
    harness.sessions(['a', 'b', 'c']);
    await settle();

    // Only the tab the user lands on is repainted. Nudging each activation in
    // turn put a demote inside a live 160 ms hold, which serialized a
    // mid-repaint frame into a worker Terminal one row short — the garbled
    // hydrate this work exists to remove.
    const dips = mountedTerms.flatMap((m) =>
      m.term.resizes.filter(([, rows]) => rows === geometry.propose!.rows - 1),
    );
    expect(dips.length).toBe(1);
    expect(harness.term('c')!.resizes.some(([, rows]) => rows === 49)).toBe(true);
  });

  it('never seeds a worker Terminal at a nudged (one row short) height', async () => {
    const harness = await createHarness();
    harness.sessions(['a', 'b', 'c']);
    await settle();
    for (const [, seeded] of workerTerms) {
      expect(seeded.rows).not.toBe(geometry.propose!.rows - 1);
    }
  });
});

describe('controller: the band-flip repaint (F2 — only on a real transition)', () => {
  it('does not repaint on an unrelated layout patch', async () => {
    const harness = await createHarness();
    harness.sessions(['a']);
    await settle();
    const before = harness.term('a')!.resizes.length;

    // A sidebar toggle / splitter commit / modal open: `layout` is reallocated,
    // so the effect re-runs, but the band did not come into view.
    harness.touchLayout();
    await settle();

    expect(harness.term('a')!.resizes.slice(before)).toEqual([]);
  });

  it('repaints when the band actually comes back into view', async () => {
    const harness = await createHarness();
    harness.sessions(['a']);
    await settle();
    harness.setBottomView('dashboard');
    await settle();
    const before = harness.term('a')!.resizes.length;

    harness.setBottomView('terminal');
    await settle();

    expect(
      harness
        .term('a')!
        .resizes.slice(before)
        .some(([, rows]) => rows === 49),
    ).toBe(true);
  });
});

describe('controller: a manual Refresh is never swallowed (F4)', () => {
  it('runs after the in-flight hold instead of being dropped', async () => {
    const harness = await createHarness();
    harness.sessions(['a']);
    await settle();

    // Start a nudge and press Refresh while its 160 ms hold is still running.
    harness.controller.refreshSession('a', { auto: true });
    await vi.advanceTimersByTimeAsync(40);
    const during = harness.term('a')!.resizes.length;
    harness.controller.refreshSession('a');
    await settle();

    const after = harness.term('a')!.resizes.slice(during);
    // The user's request produced its own dip once the first hold ended.
    expect(after.some(([, rows]) => rows === 49)).toBe(true);
  });
});

describe('controller: mid-transition output is never dropped (O4)', () => {
  it('keeps the bytes when the promote mount fails, and delivers them later', async () => {
    const harness = await createHarness();
    harness.sessions(['a', 'b']);
    await settle();
    expect(harness.controller.activeIdIn('left')).toBe('b');

    // Switch back to 'a'. Hold the worker's serialize so pty output can land
    // inside the promote window, then fail the mount: the snapshot is already
    // consumed out of the buffer, and the flush that follows finds no Terminal.
    const held = { release: (_snapshot?: string) => {} };
    heldSerialize = held;
    failMountFor = 'a';
    harness.controller.setActiveIn('left', 'a');
    await vi.advanceTimersByTimeAsync(20);
    harness.data('a', 'PRECIOUS');
    held.release();
    await settle();

    // The retry promote delivers BOTH — the snapshot the failed mount had
    // already consumed out of the buffer, and the chunk that landed mid-flight,
    // in that order. Nothing else can recover them: main keeps only a 64 KB pty
    // tail, so bytes dropped here are gone for good.
    const written = harness.term('a')!.writes.join('');
    expect(written).toContain('<snapshot a>');
    expect(written).toContain('PRECIOUS');
    expect(written.indexOf('<snapshot a>')).toBeLessThan(written.indexOf('PRECIOUS'));
  });
});

describe('controller: hydrate geometry composes with the widened repaint (#466 + #465)', () => {
  /** The steady state the two fixes have to agree about: the host fits to
   *  exactly the size the pty already has, so the hydrate is provably exact and
   *  the fit that follows is a no-op. */
  const atPtyGeometry = () => {
    ptyGeometry = { cols: 120, rows: 30 };
    geometry.propose = { cols: 120, rows: 30 };
  };

  it('builds a restored tab at the pty geometry, not at 80×24', async () => {
    // The merge hazard: `geometry` is an optional trailing argument, so losing it
    // at this call site compiles clean and silently puts the restore path back at
    // the 80×24 default — where an alternate-screen frame is mangled by
    // construction and no later fit can repair it.
    atPtyGeometry();
    const harness = await createHarness();
    harness.sessions(['a']);
    await settle();

    const mount = mountedTerms.find((m) => m.id === 'a')!;
    expect(mount.geometry).toEqual({ cols: 120, rows: 30 });
    expect(harness.term('a')!.cols).toBe(120);
  });

  it('does not nudge a restored frame that is already the pty screen', async () => {
    // Both fixes aimed at this path from opposite sides: this branch gives a
    // first activation its repaint, #466 proves the frame needs none. Nudging an
    // exact alternate-screen frame shears its bottom row, so the automatic
    // repaint must stand down.
    atPtyGeometry();
    bufferType = 'alternate';
    const harness = await createHarness();
    harness.sessions(['a']);
    await settle();

    expect(harness.term('a')!.resizes).toEqual([]);
    expect(ptyResizes).toEqual([]);
  });

  it('still nudges a restored frame whose geometry could not be proven', async () => {
    // No `termGeometry` (an older preload, or main not knowing): nothing is
    // provably exact, so the first-activation repaint this branch adds must
    // still run.
    ptyGeometry = null;
    bufferType = 'alternate';
    const harness = await createHarness();
    harness.sessions(['a']);
    await settle();

    expect(harness.term('a')!.resizes.some(([, rows]) => rows === 49)).toBe(true);
  });

  it('a manual Refresh nudges an exact frame anyway', async () => {
    // `allowExactSkip` is derived from `auto`, so the stand-down is for automatic
    // repaints only: the user pressing Refresh IS the signal that the screen is
    // wrong, whatever the geometry bookkeeping says.
    atPtyGeometry();
    bufferType = 'alternate';
    const harness = await createHarness();
    harness.sessions(['a']);
    await settle();
    expect(harness.term('a')!.resizes).toEqual([]);

    harness.controller.refreshSession('a');
    await settle();

    expect(harness.term('a')!.resizes.some(([, rows]) => rows === 29)).toBe(true);
  });
});
