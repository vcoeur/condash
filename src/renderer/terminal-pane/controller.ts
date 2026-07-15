// Controller hook for the bottom "My terms" pane.
//
// Holds everything the pane component does that is *not* JSX: the tab/column
// signals, the `onTermSessions` reconciliation, the xterm mount lifecycle, the
// live-data / exit / dashboard IPC wiring, the resize + drag-drop + search
// sub-controllers, and the imperative `TerminalPaneHandle`. `terminal-pane.tsx`
// calls this synchronously from its component body, so every `createSignal` /
// `createEffect` / `onMount` / `onCleanup` registered here still runs under the
// component's reactive owner — the ownership is identical to the pre-split
// inline version. The component keeps only the JSX shell and wires it to the
// returned surface.

import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import type { TabSummary, TermSide, TermSpawnRequest } from '@shared/types';
import { createDragDropController } from './drag-drop';
import { decideRefreshAction, refreshOnSwitchTargets, REPAINT_NUDGE_MS } from './nudge-machine';
import { decideFit, MAX_FIT_ATTEMPTS } from './fit-when-ready';
import { allocateColorSlot, deleteMeta, readLayout, readMeta, setMeta } from './persistence';
import { createResizeHandlers } from './resize';
import { createSearchController } from './search';
import { type Column, displayName, sameStringList, type Tab } from './types';
import { desiredDomIds, domVisibility, planVisibility } from './visibility-plan';
import { mountForSession, type XtermHandle } from './mount-session';
import { TerminalWorkerManager } from '../terminal-worker-manager';
import type {
  AgentChoice,
  SpawnOptions,
  TerminalPaneHandle,
  TerminalPaneProps,
} from '../terminal-pane';

/** Build the imperative + reactive controller backing a `TerminalPane`. Must be
 *  called synchronously from the component body so its reactive primitives are
 *  owned by the component root. Returns the slice of state + handlers the JSX
 *  shell wires up (signals, sub-controllers, and the ref/mutation setters for
 *  the host elements and next-spawn column). */
export function createTerminalController(props: TerminalPaneProps) {
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [activeIds, setActiveIds] = createSignal<{ left: string | null; right: string | null }>({
    left: null,
    right: null,
  });
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [activeColumn, setActiveColumn] = createSignal<Column>('left');

  const initialLayout = readLayout();
  const [paneHeight, setPaneHeight] = createSignal(initialLayout.paneHeight);
  const [splitRatio, setSplitRatio] = createSignal(initialLayout.splitRatio);

  // Track the column where the next default-spawn should land — set when the
  // user clicks a `+` button so that the right column's `+` lands a tab in
  // the right column, not always 'left'.
  let nextSpawnColumn: Column = 'left';

  // Stash of caller-supplied label/pinned per spawned id. `reconcile` is the
  // sole writer of the tabs signal; `spawn` records intent here so the
  // following onTermSessions broadcast inserts the tab with the right label.
  const pendingSpawnIntent = new Map<string, { label: string; pinned?: boolean }>();

  // Tracks tabs that are already in the process of closing so that
  // user-initiated close (right-click → Close) and process-exit close
  // don't race.
  const closingTabs = new Set<string>();

  const xterms = new Map<string, XtermHandle>();
  let leftHost: HTMLDivElement | undefined;
  let rightHost: HTMLDivElement | undefined;

  const tabsIn = (col: Column): Tab[] => tabs().filter((t) => t.side === 'my' && t.column === col);
  const activeIdIn = (col: Column): string | null => activeIds()[col];

  const setActiveIn = (col: Column, id: string | null) =>
    setActiveIds((prev) => ({ ...prev, [col]: id }));

  // The right column appears only when at least one tab lives in it.
  const isSplit = createMemo<boolean>(() => tabsIn('right').length > 0);

  const hostFor = (col: Column): HTMLDivElement | undefined =>
    col === 'left' ? leftHost : rightHost;

  // Guards re-entrancy while the xterm chunk loads on the very first mount:
  // without it, a second reconcile pass for the same id could slip past the
  // `xterms.has(id)` check (which only becomes true once the async mount
  // completes) and double-mount.
  const pendingMounts = new Set<string>();

  // ---- PR-F: hidden tabs parse in a Web Worker ----
  // Only the active tab(s) keep a live DOM Terminal. All other tabs are owned by
  // a headless `@xterm/headless` Terminal in the worker. Switching tabs is an
  // async serialize/hydrate round-trip.
  const worker = new TerminalWorkerManager();
  const workerSessions = new Set<string>();
  // Tabs that are mid-transition (serialize/mount) must not accept writes on
  // either side; they are buffered and flushed once the destination exists.
  const transitioning = new Set<string>();
  const transitionBuffers = new Map<string, string[]>();
  // Per-column count of in-flight visibility transitions. The #397 focus-churn
  // guard (`promote`) gates on the tab's OWN column via this — not the global
  // `transitioning` set — so a stuck transition (e.g. a lost worker RPC before
  // the watchdog fires) on one column can't eat focus-promotion on the other,
  // and the worker RPC watchdog time-bounds any stuck-ness (R1). Kept in lockstep
  // with `transitioning` through beginTransition / endTransition.
  const transitioningInColumn: Record<Column, number> = { left: 0, right: 0 };
  const beginTransition = (id: string, column: Column): void => {
    transitioning.add(id);
    transitioningInColumn[column] += 1;
  };
  const endTransition = (id: string, column: Column): void => {
    transitioning.delete(id);
    transitioningInColumn[column] = Math.max(0, transitioningInColumn[column] - 1);
  };
  // Sessions mid-Refresh: their pty is held one row short so the running program
  // observes a real resize and repaints. A competing `fit()` (e.g. the one at the
  // tail of every `syncVisibility`) would restore the full size within a frame
  // and collapse that dip before a debounced TUI ever samples it — so fit skips
  // any session listed here until the nudge restores the size itself.
  const nudging = new Set<string>();

  const bufferTransitionWrite = (id: string, chunk: string): void => {
    const arr = transitionBuffers.get(id);
    if (arr) arr.push(chunk);
    else transitionBuffers.set(id, [chunk]);
  };

  const flushTransitionBuffer = (id: string, target: 'dom' | 'worker'): void => {
    const chunks = transitionBuffers.get(id);
    if (!chunks || chunks.length === 0) return;
    transitionBuffers.delete(id);
    const data = chunks.join('');
    if (target === 'dom') {
      xterms.get(id)?.term.write(data);
    } else {
      worker.write(id, data);
    }
  };

  /** Move an existing xterm element to a new column's host (used when the
   * user drags a tab between columns). */
  const movemount = (id: string, newColumn: Column): void => {
    const handle = xterms.get(id);
    if (!handle || handle.column === newColumn) return;
    const host = hostFor(newColumn);
    if (!host) return;
    host.appendChild(handle.element);
    handle.column = newColumn;
    try {
      handle.fit.fit();
    } catch {
      /* not yet sized */
    }
  };

  /** Fit a session's terminal, retrying across animation frames until its host
   *  is laid out at a real size. `FitAddon.proposeDimensions()` sizes the grid
   *  from the host's computed width/height, so a fit run before the host has
   *  resolved (a freshly-shown tab whose flex box hasn't settled, a host still
   *  0-sized from a visibility transition) returns undefined / a NaN axis and
   *  `fit()` is a no-op — the grid strands at the default 80×24 inside a larger
   *  pane (the "terminal renders into a small box" bug), and nothing re-fits once
   *  the host settles. Retrying on rAF closes that so the terminal fills its host.
   *  A session mid-nudge is skipped: its pty is held one row short on purpose and
   *  refitting now would collapse the dip before the TUI repaints (see the
   *  Refresh nudge below). The live-handle re-read each frame drops the retry if
   *  the tab was demoted, closed, or re-mounted meanwhile. */
  const fitWhenReady = (id: string, attemptsLeft = MAX_FIT_ATTEMPTS): void => {
    const handle = xterms.get(id);
    if (!handle || nudging.has(id)) return;
    let dims: { cols: number; rows: number } | undefined;
    try {
      dims = handle.fit.proposeDimensions();
    } catch {
      dims = undefined;
    }
    const action = decideFit(dims, attemptsLeft);
    if (action === 'retry') {
      requestAnimationFrame(() => fitWhenReady(id, attemptsLeft - 1));
      return;
    }
    if (action === 'giveup') return;
    try {
      handle.fit.fit();
    } catch {
      /* host not sized yet / term disposed */
    }
  };

  /** Focus + fit the active DOM Terminal, if one exists. */
  const focusActiveDom = (): void => {
    const id = activeIdIn(activeColumn());
    if (!id) return;
    const handle = xterms.get(id);
    if (handle) {
      // fitWhenReady skips a nudging session (its pty is held one row short) and
      // retries until the host is laid out, so a tab shown before its flex box
      // settles still fills the host rather than stranding at 80×24.
      fitWhenReady(id);
      handle.term.focus();
    }
  };

  // Keep the visible terminal fitted to its host at all times. The explicit fits
  // (focusActiveDom / view-switch / nudge / splitter-drag / window-resize) each
  // fire at one moment; none covers a host that changes size for some OTHER
  // reason — a flex/grid reflow settling a frame late, the top band collapsing,
  // a window maximize the 'resize' listener sampled mid-animation. Once a fit has
  // run against a smaller or not-yet-laid-out host, nothing re-fits it and the
  // terminal is stranded narrower than its pane (the "small box" bug). A
  // ResizeObserver on each column host closes that: whenever a host's box
  // actually changes size, refit that column's active terminal. RO callbacks are
  // frame-batched (no storm), the nudge resizes the pty not the host (so it never
  // fires mid-nudge), and fitWhenReady skips a nudging / not-laid-out terminal —
  // so this is a pure backstop that can't fight the tuned resize/nudge paths.
  const hostResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const col: Column | null =
        entry.target === leftHost ? 'left' : entry.target === rightHost ? 'right' : null;
      if (!col) continue;
      const id = activeIdIn(col);
      if (id) fitWhenReady(id);
    }
  });
  onCleanup(() => hostResizeObserver.disconnect());

  /** Serialize/hydrate guard. Visibility transitions are async (dynamic import
   *  of xterm + worker round-trip), so concurrent calls chain on a single
   *  promise to avoid interleaving demote/promote races for the same session. */
  let visibilityChain: Promise<void> = Promise.resolve();

  /** Ensure the only live DOM Terminals are the active tabs; every other tab is
   *  owned by a headless worker Terminal. Promoting a tab pulls a serialized
   *  snapshot from the worker and hydrates a fresh DOM Terminal; demoting a tab
   *  serializes the DOM Terminal, seeds the worker, and disposes the DOM. */
  const syncVisibility = async (): Promise<void> => {
    if (!props.open || props.bottomView !== 'terminal') {
      // Pane closed or dashboard shown: hide every DOM Terminal's element and
      // release GPU contexts; do not dispose them so the buffer stays live.
      for (const [, h] of xterms) {
        h.element.style.display = 'none';
        h.mounted.setVisible(false);
      }
      return;
    }

    // Snapshot the promote/demote plan up front: which desired tabs need a DOM
    // Terminal, which mounted tabs should demote to the worker. The per-id work
    // below mutates `xterms` / `transitioning` only for the id it is processing,
    // so a plan computed here stays valid across the loop (see visibility-plan).
    const desired = desiredDomIds({ left: activeIdIn('left'), right: activeIdIn('right') });
    const plan = planVisibility({ desired, mounted: xterms.keys(), transitioning });

    // Promote worker tabs that should be visible.
    for (const id of plan.toPromote) {
      const tab = tabs().find((t) => t.id === id);
      const col = tab?.column ?? 'left';
      beginTransition(id, col);
      try {
        const fromWorker = workerSessions.has(id);
        let replay: string;
        if (fromWorker) {
          try {
            replay = await worker.serialize(id);
          } catch {
            // The worker RPC failed / timed out (watchdog). Don't leave the
            // active tab blank: mount with whatever buffered tail we have so the
            // user gets a live terminal (scrollback may be lost) rather than an
            // empty pane, and the transition still clears via the finally (R1).
            replay = transitionBuffers.get(id)?.join('') ?? '';
            transitionBuffers.delete(id);
          }
        } else {
          // Defensive: this tab never had a worker Terminal (shown before it was
          // ever demoted). Replay the buffered tail and drop it here so the
          // flush below does not write the same bytes a second time.
          replay = transitionBuffers.get(id)?.join('') ?? '';
          transitionBuffers.delete(id);
        }
        workerSessions.delete(id);
        // The snapshot captured everything; the worker Terminal is now stale.
        // Dispose it so a hidden→shown→closed session does not leak its headless
        // Terminal (and full scrollback) in the worker for the app's lifetime.
        // Fire-and-forget, but `.catch` it: the dispose RPC can now reject via the
        // watchdog, and an unhandled rejection would spam the renderer (R1).
        if (fromWorker) void worker.dispose(id).catch(() => undefined);
        await mountForSession(mountCtx, id, col, replay);
        flushTransitionBuffer(id, 'dom');
      } finally {
        endTransition(id, col);
      }
    }

    // Demote DOM tabs that should be hidden.
    for (const tid of plan.toDemote) {
      const h = xterms.get(tid);
      if (!h) continue;
      const demoteColumn = h.column;
      beginTransition(tid, demoteColumn);
      try {
        const snapshot = h.serialize.serialize();
        await worker.create(tid, h.term.cols, h.term.rows, h.term.options.scrollback as number);
        worker.write(tid, snapshot);
        workerSessions.add(tid);
        h.detachListeners?.();
        h.mounted.dispose();
        h.element.remove();
        xterms.delete(tid);
        flushTransitionBuffer(tid, 'worker');
      } finally {
        endTransition(tid, demoteColumn);
      }
    }

    // Update CSS visibility + WebGL pool for the remaining DOM tabs. Read the
    // active ids fresh here (not the top-of-function `desired`): the awaited
    // promote/demote round-trips above may have let a later click move the
    // active tab, and the visible terminal must track that latest state.
    const active = { left: activeIdIn('left'), right: activeIdIn('right') };
    const mountedTabs = Array.from(xterms, ([id, h]) => ({ id, column: h.column }));
    for (const [tid, visible] of domVisibility(mountedTabs, active)) {
      const h = xterms.get(tid);
      if (!h) continue;
      h.element.style.display = visible ? 'flex' : 'none';
      h.mounted.setVisible(visible);
    }

    focusActiveDom();
  };

  /** Public sync entry used by search and handle methods that need the active
   *  terminal focused after a UI change. */
  const focusActive = (): void => {
    visibilityChain = visibilityChain.then(() => syncVisibility()).catch(() => undefined);
  };

  const search = createSearchController({
    getActiveSearch: () => {
      const id = activeIdIn(activeColumn());
      return id ? (xterms.get(id)?.search ?? null) : null;
    },
    focusActive,
  });

  /** Custom-key hook for xterm — handles Ctrl+F (search), Ctrl+Up/Down (jump
   *  to prompt) before the bytes hit the shell. */
  const handleXtermKey = (ev: KeyboardEvent, _id: string): boolean => {
    const ctrl = ev.ctrlKey && !ev.metaKey && !ev.altKey;
    if (!ctrl || ev.type !== 'keydown') return true;
    if (!ev.shiftKey && (ev.key === 'f' || ev.key === 'F')) {
      ev.preventDefault();
      search.openSearch();
      return false;
    }
    if (!ev.shiftKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      const id = activeIdIn(activeColumn());
      const handle = id ? xterms.get(id) : null;
      if (handle) {
        ev.preventDefault();
        handle.mounted.jumpToPrompt(ev.key === 'ArrowUp' ? -1 : 1);
        return false;
      }
    }
    return true;
  };

  // Context passed to the extracted mount helper. Kept in one object so the
  // helper can be unit-tested without the full Solid controller (S2).
  const mountCtx = {
    xterms,
    pendingMounts,
    hostFor,
    xtermPrefs: props.xtermPrefs,
    handleXtermKey,
    setTabs,
    activeIdIn,
    activeColumn,
    setActiveIn,
    setActiveColumn,
    transitioningInColumn,
  };

  // ---- onTermSessions: single source of truth for adds/removes ----
  const reconcile = async (
    snap: readonly {
      id: string;
      side: TermSide;
      exited?: number;
      repo?: string;
      memBytes?: number;
      memMaxBytes?: number;
    }[],
  ) => {
    const known = new Set(tabs().map((t) => t.id));
    for (const s of snap) {
      if (s.side !== 'my' || known.has(s.id)) continue;
      // Await termAttach first so that any in-flight `spawn` invoke reply has
      // resolved by the time we build the tab — `pendingSpawnIntent` is set
      // synchronously after `termSpawn` returns, and we want to read it here.
      const attach = await window.condash.termAttach(s.id);
      // Re-check membership after the await: `known` was snapshotted at
      // entry, so without this a session inserted by another path while the
      // attach was in flight would be inserted twice (duplicate tab rows).
      if (tabs().some((t) => t.id === s.id)) continue;
      const intent = pendingSpawnIntent.get(s.id);
      pendingSpawnIntent.delete(s.id);
      const meta = readMeta()[s.id];
      const label = intent?.label ?? meta?.label ?? (s.repo ? `${s.repo} (run)` : 'shell');
      const column: Column = meta?.column ?? nextSpawnColumn;
      nextSpawnColumn = 'left';
      const pinned = intent?.pinned ?? meta?.pinned;
      // Reuse the persisted slot on restore; allocate the next zebra slot for
      // a genuinely new tab. Frozen here for the tab's lifetime.
      const colorSlot = meta?.colorSlot ?? allocateColorSlot();
      const tab: Tab = {
        id: s.id,
        side: 'my',
        column,
        label,
        customName: meta?.customName,
        colorSlot,
        pinned,
        exited: s.exited,
        memBytes: s.memBytes,
        memMaxBytes: s.memMaxBytes,
      };
      setTabs((prev) => [...prev, tab]);
      setMeta(s.id, { label, customName: meta?.customName, column, colorSlot, pinned });
      // Any termData that arrived before this mount was buffered by the
      // onTermData fallback, but it is already part of `attach.output` (the pty
      // buffer tail). Drop that buffer so it is not replayed a second time when
      // this tab is first demoted to the worker. Chunks that land during the
      // async mount below are re-buffered and flushed once the DOM Terminal
      // exists.
      transitionBuffers.delete(s.id);
      await mountForSession(mountCtx, s.id, column, attach?.output);
      flushTransitionBuffer(s.id, 'dom');
      setActiveIn(column, s.id);
      setActiveColumn(column);
      queueMicrotask(focusActive);
    }
    // Reconcile the exited/memory fields onto the existing tabs while preserving
    // object identity: the main process rebroadcasts the FULL snapshot every 2.5 s
    // (the memory sampler), and a fresh `{ ...t }` per tab churned every
    // reference-keyed row's `<For>` mount — busy-dot animations restarted, hover
    // popovers died — even when nothing changed. Build an id→snapshot map (drops
    // the O(n²) `snap.find` in the map) and return the SAME object when
    // exited/memBytes/memMaxBytes are unchanged, allocating only on a real change;
    // return `prev` unchanged when no tab moved so the signal doesn't even notify
    // (review finding T5).
    const snapById = new Map(snap.map((s) => [s.id, s]));
    setTabs((prev) => {
      let mutated = false;
      const next = prev.map((t) => {
        const s = snapById.get(t.id);
        if (!s) return t;
        if (t.exited === s.exited && t.memBytes === s.memBytes && t.memMaxBytes === s.memMaxBytes) {
          return t;
        }
        mutated = true;
        return { ...t, exited: s.exited, memBytes: s.memBytes, memMaxBytes: s.memMaxBytes };
      });
      return mutated ? next : prev;
    });
    const stillMyById = new Map<string, boolean>();
    for (const s of snap) stillMyById.set(s.id, s.side === 'my');
    const toDrop = tabs()
      .filter((t) => stillMyById.get(t.id) !== true)
      .map((t) => t.id);
    for (const id of toDrop) {
      const handle = xterms.get(id);
      handle?.detachListeners?.();
      handle?.mounted.dispose();
      handle?.element.remove();
      xterms.delete(id);
      if (workerSessions.has(id)) {
        workerSessions.delete(id);
        // `.catch`: the dispose RPC can now reject via the watchdog, and an
        // unhandled rejection from this fire-and-forget call would spam the
        // renderer (R1).
        void worker.dispose(id).catch(() => undefined);
      }
      transitionBuffers.delete(id);
      // The tab is gone from the snapshot — its close has landed, so the
      // closing guard can be released (otherwise the set grows forever).
      closingTabs.delete(id);
    }
    if (toDrop.length > 0) {
      setTabs((prev) => prev.filter((t) => !toDrop.includes(t.id)));
      setActiveIds((prev) => ({
        left: toDrop.includes(prev.left ?? '') ? null : prev.left,
        right: toDrop.includes(prev.right ?? '') ? null : prev.right,
      }));
      for (const col of ['left', 'right'] as Column[]) {
        if (activeIdIn(col)) continue;
        const fallback = tabsIn(col).at(-1)?.id ?? null;
        setActiveIn(col, fallback);
      }
      queueMicrotask(focusActive);
    }
  };

  // Serialise reconcile passes through a promise queue: the onTermSessions
  // broadcast and the onMount termList() seed can overlap, and each pass
  // snapshots `known` at entry — two interleaved passes could otherwise both
  // insert the same session (the per-insert re-check above is the second
  // belt for anything that still slips through).
  let reconcileChain: Promise<void> = Promise.resolve();
  const queueReconcile = (
    snap: readonly {
      id: string;
      side: TermSide;
      exited?: number;
      repo?: string;
      memBytes?: number;
      memMaxBytes?: number;
    }[],
  ): void => {
    reconcileChain = reconcileChain.then(() => reconcile(snap)).catch(() => undefined);
  };

  const offTermSessions = window.condash.onTermSessions((snap) => queueReconcile(snap));
  onCleanup(offTermSessions);

  onMount(() => {
    void window.condash.termList().then((snap) => queueReconcile(snap));
  });

  // ---- spawn helpers ----
  const uniqueLabel = (base: string): string => {
    const taken = new Set(tabs().map((t) => t.label));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} (${i})`;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  };

  const spawn = async (
    request: TermSpawnRequest,
    label: string,
    opts?: SpawnOptions,
  ): Promise<string> => {
    const { id } = await window.condash.termSpawn(request);
    const pinned = opts?.pinned;
    // Record intent first — reconcile reads it before falling back to meta
    // or default labels. Setting intent before setMeta keeps the two reads
    // synchronous from reconcile's perspective.
    pendingSpawnIntent.set(id, { label, pinned });
    setMeta(id, { label, column: nextSpawnColumn, pinned });
    return id;
  };

  const spawnUserShell = async (
    agent: AgentChoice = null,
    sd: TermSide = 'my',
    titleOverride?: string,
    taskContext?: TermSpawnRequest['taskContext'],
  ): Promise<string> => {
    const label = uniqueLabel(titleOverride ?? agent?.label ?? 'shell');
    // Pin the label when the caller picked an agent or supplied an explicit
    // title. The bare "New shell" path leaves the tab unpinned so the shell's
    // OSC 7 cwd basename drives the displayed title.
    return spawn(
      {
        side: sd,
        command: agent?.command,
        cwd: props.cwd ?? undefined,
        taskContext,
      },
      label,
      { pinned: agent !== null || titleOverride !== undefined },
    );
  };

  /** Resolve an agent id (or null) to its `Agent` from props.agents. Returns
   *  null for a missing id — callers treat that as the plain `New shell` path. */
  const resolveAgent = (id: string | null): AgentChoice => {
    if (id === null) return null;
    return props.agents.find((a) => a.id === id) ?? null;
  };

  // ---- live data + exit notification ----
  const offTermData = window.condash.onTermData(({ id, data }) => {
    if (transitioning.has(id)) {
      bufferTransitionWrite(id, data);
    } else if (xterms.has(id)) {
      xterms.get(id)!.term.write(data);
    } else if (workerSessions.has(id)) {
      worker.write(id, data);
    } else {
      // Tab exists in the snapshot but has not been mounted or seeded yet
      // (race between termData and reconcile). Buffer for the first show.
      bufferTransitionWrite(id, data);
    }
  });
  const offTermExit = window.condash.onTermExit(({ id, code: _code }) => {
    // Auto-close the tab on process exit — the previous "[process exited N]"
    // marker stayed around forever and forced a manual click on the close
    // button. If the user wants to inspect the buffer, the Save-buffer
    // button on the tab strip dumps it to a .txt before close lands.
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, exited: _code } : t)));
    if (!closingTabs.has(id)) closeTab(id);
  });

  // ---- dashboard: live per-tab LLM summaries (title + hover popover) ----
  // Merge the engine's per-sid summaries onto the matching tabs. When the
  // feature is off no pushes arrive, so `llmTitle` stays undefined and the tab
  // falls back to its cwd / OSC title.
  const applyTabSummaries = (summaries: TabSummary[]): void => {
    if (summaries.length === 0) return;
    const bySid = new Map(summaries.map((s) => [s.sid, s]));
    // Field-compare before allocating: the engine pushes summaries at its cadence
    // and re-sends unchanged title/contextLines/currentAction for a steady tab, so
    // a fresh `{ ...t }` per summarized sid rebuilt its reference-keyed row for
    // nothing. Return the SAME object when the three summary-derived fields are
    // unchanged (contextLines compared element-wise), and `prev` when no tab moved
    // so the signal doesn't notify (review finding T7).
    setTabs((prev) => {
      let mutated = false;
      const next = prev.map((t) => {
        const summary = bySid.get(t.id);
        if (!summary) return t;
        if (
          t.llmTitle === summary.title &&
          t.currentAction === summary.currentAction &&
          sameStringList(t.contextLines, summary.contextLines)
        ) {
          return t;
        }
        mutated = true;
        return {
          ...t,
          llmTitle: summary.title,
          contextLines: summary.contextLines,
          currentAction: summary.currentAction,
        };
      });
      return mutated ? next : prev;
    });
  };
  const offDashboard = window.condash.onDashboardTabSummaries(({ summaries }) =>
    applyTabSummaries(summaries),
  );
  // Seed from the last persisted snapshot so titles show without waiting for the
  // next engine cycle.
  void window.condash.dashboardGetState().then((state) => {
    if (state) applyTabSummaries(state.tabs);
  });

  onCleanup(() => {
    offTermData();
    offTermExit();
    offDashboard();
    for (const [, { mounted, element, detachListeners }] of xterms) {
      detachListeners?.();
      mounted.dispose();
      element.remove();
    }
    xterms.clear();
    // Tear down the worker thread wholesale. This also frees any headless
    // Terminals for sessions no longer tracked in `workerSessions` (e.g. a tab
    // shown again after being hidden), which a per-session dispose loop misses.
    worker.terminate();
    workerSessions.clear();
    transitionBuffers.clear();
  });

  const closeTab = (id: string) => {
    if (closingTabs.has(id)) return;
    closingTabs.add(id);
    void window.condash.termClose(id);
    deleteMeta(id);
  };

  const commitRename = (id: string, value: string) => {
    const trimmed = value.trim();
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, customName: trimmed || undefined } : t)),
    );
    const tab = tabs().find((t) => t.id === id);
    if (tab) {
      setMeta(id, {
        label: tab.label,
        customName: trimmed || undefined,
        column: tab.column,
        colorSlot: tab.colorSlot,
        pinned: tab.pinned,
      });
    }
    setRenamingId(null);
  };

  // ---- column / pane resize ----
  const resize = createResizeHandlers({
    paneHeight,
    setPaneHeight,
    splitRatio,
    setSplitRatio,
    fitAddons: () => Array.from(xterms.values(), (h) => h.fit),
  });
  onMount(() => window.addEventListener('resize', resize.onWindowResize));
  onCleanup(() => window.removeEventListener('resize', resize.onWindowResize));

  // Publish the pane's rendered height as a CSS variable so modal backdrops can
  // stop just above the terminal (it stays visible + usable while a popup is
  // open). A ResizeObserver covers every height change uniformly: open / close,
  // resize-drag, split, and window resize.
  let paneSection: HTMLElement | undefined;
  const publishPaneHeight = (height: number): void => {
    document.documentElement.style.setProperty('--terminal-pane-height', `${Math.round(height)}px`);
  };
  onMount(() => {
    if (!paneSection) return;
    publishPaneHeight(paneSection.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const box = entry?.borderBoxSize?.[0];
      publishPaneHeight(
        box ? box.blockSize : (entry?.target as HTMLElement).getBoundingClientRect().height,
      );
    });
    observer.observe(paneSection);
    onCleanup(() => {
      observer.disconnect();
      // Drop the gap if the pane ever unmounts so a later layout isn't clipped.
      document.documentElement.style.setProperty('--terminal-pane-height', '0px');
    });
  });

  createEffect(() => {
    void activeIds();
    void activeColumn();
    void isSplit();
    queueMicrotask(focusActive);
  });
  createEffect(() => {
    if (props.open) queueMicrotask(focusActive);
  });

  // ---- auto-refresh on tab switch ----
  // Repaint a tab the moment it becomes its column's active tab — the same fix
  // as the manual Refresh button, applied automatically so a hidden→visible tab
  // never shows a stale hydrated frame. On by default (`autoRefreshOnTabSwitch`
  // is treated as true unless explicitly `false`): every tab — full-screen TUI,
  // plain shell, agent session — is nudged on switch. Setting it to `false`
  // restricts the nudge to alt-buffer tabs only (live full-screen TUIs, the one
  // kind whose hydrated frame is inherently lossy — `SerializeAddon` can't
  // reproduce their cursor / scroll-region / colour state); plain shells then
  // hydrate faithfully and are left alone. Diffing each column's active id
  // against its previous value fires only on a genuine switch to a *different*
  // tab: it skips first-open (prev null) and ignores the no-op signal re-fire
  // `refreshSession` makes when it re-asserts the active id. Deferred to a
  // microtask so we don't write the active-id signal from inside an effect;
  // `refreshSession` itself decides, once the tab has hydrated, whether the
  // alt-buffer condition holds.
  let prevActive: { left: string | null; right: string | null } = { left: null, right: null };
  createEffect(() => {
    const current = activeIds();
    for (const target of refreshOnSwitchTargets(
      prevActive,
      current,
      props.autoRefreshOnTabSwitch,
    )) {
      queueMicrotask(() => refreshSession(target.id, { onlyIfAltBuffer: target.onlyIfAltBuffer }));
    }
    prevActive = { left: current.left, right: current.right };
  });

  // Switching back from the Dashboard body re-shows the xterm hosts (they are
  // CSS-hidden, not unmounted, so terminals survive). xterm must refit to the
  // restored dimensions, otherwise the grid is sized for the hidden (0×0) host.
  createEffect(() => {
    if (props.open && props.bottomView === 'terminal') {
      queueMicrotask(() => {
        // The hosts were CSS-hidden while the Dashboard body showed, so the
        // just-restored host may still read 0×0 this microtask — fitWhenReady
        // retries until it is laid out rather than one-shot no-opping on it.
        for (const id of xterms.keys()) fitWhenReady(id);
        focusActive();
      });
    }
  });

  // ---- drag-to-reorder + drag-between-columns ----
  const dnd = createDragDropController({
    tabs,
    setTabs,
    moveMount: movemount,
    setActiveIn,
    setActiveColumn,
    focusActive,
  });

  // ---- save buffer ("export run output") ----
  const saveActiveBuffer = (): void => {
    const id = activeIdIn(activeColumn());
    if (!id) return;
    const handle = xterms.get(id);
    if (!handle) return;
    const text = handle.serialize.serialize();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const tab = tabs().find((t) => t.id === id);
    a.download = `${(tab && displayName(tab)) || 'terminal'}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ---- refresh (repaint) ----
  // The nudge timing (`REPAINT_NUDGE_MS`) and the whether/what-kind decisions
  // (`decideRefreshAction`) live in the pure `nudge-machine` module; the wiring
  // below keeps only the effects — the promote, the timer, and the DOM resize.

  /** Force the program running in a session to repaint its whole screen by
   *  nudging the pty one row shorter and back (two SIGWINCHes). Full-screen TUIs
   *  redraw from scratch on resize; plain shells ignore it. This is the escape
   *  hatch for the half-frame a live TUI can show after the hidden-tab
   *  serialize/hydrate round-trip (see `terminal-worker` / internals §terminal-
   *  worker): `SerializeAddon` can't perfectly reproduce a mid-repaint TUI's
   *  cursor and scroll-region state, so the snapshot hydrated on tab-switch may
   *  carry stale rows. Scrollback is kept. The session is promoted to its
   *  column's active DOM Terminal first so there is a live terminal to resize.
   *
   *  `onlyIfAltBuffer` restricts the nudge to a session currently on the
   *  alternate screen buffer — i.e. a live full-screen TUI, the only kind whose
   *  hydrated frame is lossy. A plain shell hydrates faithfully, so nudging it on
   *  every switch would just churn its layout for nothing. The auto-on-switch
   *  path passes `onlyIfAltBuffer: true` only when the user has explicitly set
   *  `autoRefreshOnTabSwitch: false`; the default (and the manual Refresh button)
   *  always nudges. */
  const refreshSession = (id: string | null, opts?: { onlyIfAltBuffer?: boolean }): void => {
    if (!id) return;
    const tab = tabs().find((t) => t.id === id);
    if (!tab) return;
    // Promote the session to its column's active DOM Terminal so there is a live
    // terminal to resize — but only when it isn't already active. Re-asserting an
    // unchanged active id still allocates a new signal object, which re-runs the
    // focus effect → a chained `syncVisibility` → `focusActiveDom`, and that
    // extra fit is exactly what used to collapse the nudge dip.
    if (activeIdIn(tab.column) !== id) setActiveIn(tab.column, id);
    if (activeColumn() !== tab.column) setActiveColumn(tab.column);
    // Chain after any in-flight promote/demote so the DOM Terminal for this
    // session exists before we resize it, then wait one animation frame so the
    // host layout can settle before the nudge starts.
    visibilityChain = visibilityChain
      .then(async () => {
        await syncVisibility();
        // Give the host one animation frame to settle before the nudge begins.
        // The visibility transition just promoted the tab and started a
        // fitWhenReady retry; if the nudge starts immediately it adds the id to
        // `nudging`, which cancels that retry and leaves a terminal that has not
        // yet reached its real size. A short beat lets the in-flight fit finish
        // before we deliberately resize the terminal one row shorter.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const handle = xterms.get(id);
        // The pure decision: skip (no live terminal — demoted / closed /
        // re-mounted mid-hydration), focus-only (the alt-buffer opt-out excluded a
        // faithfully-hydrated shell, or the terminal is too short to give up a
        // row), or nudge. `bufferType` is read post-hydrate so it reflects the
        // snapshot just replayed.
        const action = decideRefreshAction({
          mounted: Boolean(handle),
          bufferType: handle?.term.buffer.active.type,
          rows: handle?.term.rows,
          onlyIfAltBuffer: opts?.onlyIfAltBuffer ?? false,
        });
        if (action.kind === 'skip') return;
        // Past `skip`, `decideRefreshAction` guarantees a live handle; bind it
        // non-nullable so the deferred restore below narrows cleanly.
        const live = handle!;
        if (action.kind === 'focus-only' && action.reason === 'altGate') {
          live.term.focus();
          return;
        }
        // Past the alt-buffer gate. Test seam (mirrors `__condashXterms`): record
        // here so e2e can assert the nudge fired without racing the sub-frame
        // resize. Inert unless the test opts into the registry.
        if (document.body.hasAttribute('data-test-xterm-registry')) {
          (window.__condashRefreshLog ??= []).push(id);
        }
        if (action.kind === 'focus-only') {
          // reason === 'tooShort': a ≤1-row terminal can't lose a row.
          live.term.focus();
          return;
        }
        // Hold the pty one row short across REPAINT_NUDGE_MS so a debounced TUI
        // samples the smaller size and repaints; `nudging` keeps a competing fit
        // from restoring the size early (see `focusActiveDom`).
        const { cols, rows } = live.term;
        nudging.add(id);
        live.term.resize(cols, rows - 1);
        setTimeout(() => {
          nudging.delete(id);
          // Bail if the tab was demoted, closed, or re-mounted while we waited.
          if (xterms.get(id) !== live) return;
          // fitWhenReady (not a bare fit) so the restore still lands even if the
          // host is not laid out at its real size by REPAINT_NUDGE_MS — it retries
          // across frames instead of no-opping and stranding the grid.
          fitWhenReady(id);
          // One more delayed fit as a backstop: the host may settle a frame or
          // two after the nudge window, or a ResizeObserver callback may have
          // fired while `nudging` blocked it and will not fire again (the host
          // size did not change). The second attempt is a no-op if the first
          // restore already succeeded.
          setTimeout(() => {
            if (xterms.get(id) !== live) return;
            fitWhenReady(id);
          }, 150);
          try {
            live.term.focus();
          } catch {
            /* term disposed */
          }
        }, REPAINT_NUDGE_MS);
      })
      .catch(() => {
        nudging.delete(id);
      });
  };

  // ---- exposed handle ----
  const handle: TerminalPaneHandle = {
    spawn,
    switchTo: (_sd, id) => {
      if (!id) return;
      const tab = tabs().find((t) => t.id === id);
      if (!tab) return;
      setActiveIn(tab.column, id);
      setActiveColumn(tab.column);
      queueMicrotask(focusActive);
    },
    spawnUserShell,
    moveActiveTab: (direction) => {
      const col = activeColumn();
      const ids = tabsIn(col).map((t) => t.id);
      const idx = ids.indexOf(activeIdIn(col) ?? '');
      if (idx === -1) return;
      const nextIdx = (idx + direction + ids.length) % ids.length;
      setActiveIn(col, ids[nextIdx]);
      queueMicrotask(focusActive);
    },
    typeIntoActive: (text) => {
      const id = activeIdIn(activeColumn());
      if (!id) return;
      void window.condash.termWrite(id, text);
      // Drive focus into the active xterm so the next keystroke lands in the
      // shell — callers (Work on, screenshot paste) all want this. Without it
      // the click that triggered typeIntoActive leaves focus on the dashboard
      // button and the user has to click the pane again before typing.
      queueMicrotask(focusActive);
    },
    hasActive: () => Boolean(activeIdIn(activeColumn())),
    getActiveSessionId: () => activeIdIn(activeColumn()),
  };
  onMount(() => props.registerHandle(handle));
  onCleanup(() => props.registerHandle(null));

  /** Store a column's xterm host element (set from the column's ref) and observe
   *  it for size changes so the column's active terminal always tracks its host.
   *  Unobserve any previous element for the column first — the right column's host
   *  is re-created on every split toggle, and a ResizeObserver keeps a strong ref
   *  to each observed target until unobserve/disconnect, so re-registering without
   *  this would accumulate detached hosts. */
  const registerHost = (col: Column, el: HTMLDivElement): void => {
    const prev = col === 'left' ? leftHost : rightHost;
    if (prev && prev !== el) hostResizeObserver.unobserve(prev);
    if (col === 'left') leftHost = el;
    else rightHost = el;
    hostResizeObserver.observe(el);
  };

  /** Direct the next default spawn at `col` (set when a `+` button is hit). */
  const setNextSpawnColumn = (col: Column): void => {
    nextSpawnColumn = col;
  };

  /** Store the pane `<section>` element (set from its ref) for the height
   *  ResizeObserver wired up above. */
  const registerPaneSection = (el: HTMLElement): void => {
    paneSection = el;
  };

  /** Activate the tab that owns session `id`, focusing its terminal — used by
   *  the Dashboard to jump from a tab card to its terminal. Only `my`-side tabs
   *  live in this pane (the dashboard roster is `my`-side only), so a miss just
   *  means the tab closed between the roster push and the click; returns whether
   *  a tab was found so the caller can skip the band swap on a stale card. */
  const activateSession = (id: string): boolean => {
    const tab = tabs().find((t) => t.side === 'my' && t.id === id);
    if (!tab) return false;
    setActiveColumn(tab.column);
    setActiveIn(tab.column, id);
    queueMicrotask(focusActive);
    return true;
  };

  return {
    tabsIn,
    activeIdIn,
    activeColumn,
    renamingId,
    setActiveColumn,
    setActiveIn,
    activateSession,
    setRenamingId,
    commitRename,
    closeTab,
    spawnUserShell,
    resolveAgent,
    saveActiveBuffer,
    refreshSession,
    dnd,
    search,
    resize,
    isSplit,
    paneHeight,
    splitRatio,
    registerHost,
    setNextSpawnColumn,
    registerPaneSection,
  };
}
