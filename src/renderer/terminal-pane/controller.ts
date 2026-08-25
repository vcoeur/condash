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
import type { TabSummary, TermSession, TermSide, TermSpawnRequest } from '@shared/types';
import { createDragDropController } from './drag-drop';
import {
  createNudgeRegistry,
  decideRefreshAction,
  refreshOnSwitchTargets,
  REPAINT_NUDGE_MS,
} from './nudge-machine';
import { decideFit, MAX_FIT_ATTEMPTS } from './fit-when-ready';
import { allocateColorSlot, deleteMeta, readLayout, readMeta, setMeta } from './persistence';
import { createResizeHandlers } from './resize';
import { createSearchController } from './search';
import { createTransitionBuffers } from './transition-buffers';
import { type Column, displayName, sameStringList, type Tab } from './types';
import {
  activeIdsAfterDrop,
  desiredDomIds,
  domVisibility,
  planVisibility,
} from './visibility-plan';
import { mountForSession, type XtermHandle } from './mount-session';
import { TerminalWorkerManager } from '../terminal-worker-manager';
import { rendererPerf } from '../perf-renderer';
import { pruneLinks, repointSid, setActiveSession } from '../link-store';
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
  // Observe the parked char depth on every growth: it is the production evidence
  // for (or against) the unbounded-growth hazard the buffer's cap addresses, and
  // a peak (not a sum) because a depth is a level, not a rate. Costs nothing
  // while perf recording is off.
  const transitionBuffers = createTransitionBuffers((chars) =>
    rendererPerf.observeMax('transitionBufferChars', chars),
  );
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
  // any session held here until the nudge restores the size itself. Claims are
  // keyed by the HANDLE, not just the id: a switch destroys and rebuilds a
  // session's DOM Terminal, so an id-only claim let a stale timer block the new
  // handle's fit and clear a live nudge's guard (see `createNudgeRegistry`).
  const nudging = createNudgeRegistry<XtermHandle>();

  // Geometry each hidden tab's snapshot was produced at (the worker Terminal is
  // created at the demoting DOM Terminal's size and keeps parsing at it). Paired
  // with the pty's own geometry at promote, this is what lets the controller know
  // a hydrate reproduced the pty's screen *exactly* rather than merely plausibly.
  const workerGeometry = new Map<string, { cols: number; rows: number }>();
  // Sessions whose live DOM Terminal still holds a provably exact frame: the
  // snapshot's geometry, the pty's geometry and the grid it was built at all
  // agreed, and nothing has resized it since. The auto-refresh nudge is skipped
  // for these — see `decideRefreshAction`.
  const exactHydrates = new Map<string, { cols: number; rows: number }>();

  /** End an in-flight nudge before its terminal is torn down, restoring the row
   *  it gave up. A demote that lands inside the 160 ms hold would otherwise
   *  serialize a mid-repaint frame AND create the worker Terminal one row short
   *  (`worker.create(..., h.term.rows, ...)`), leaving the pty short until the
   *  next promote's fit — the garbled hydrate this whole path exists to remove.
   *  The nudge is the only resize a held handle can receive (every fit path skips
   *  it), so `rows + 1` is exactly the pre-nudge height. */
  const settleNudge = (id: string, handle: XtermHandle): void => {
    if (!nudging.isHeldBy(id, handle)) return;
    nudging.release(id, handle);
    try {
      handle.term.resize(handle.term.cols, handle.term.rows + 1);
    } catch {
      /* term already disposed */
    }
  };

  /** In-flight fit retry chain per session, so per-frame callers share one chain
   *  instead of each starting a 12-frame budget of their own. */
  const fitRetries = new Map<string, number>();
  onCleanup(() => {
    for (const frame of fitRetries.values()) cancelAnimationFrame(frame);
    fitRetries.clear();
  });

  const flushTransitionBuffer = (id: string, target: 'dom' | 'worker'): void => {
    transitionBuffers.flush(id, (data) => {
      if (target === 'worker') {
        worker.write(id, data);
        return true;
      }
      // No DOM Terminal to write into (the mount bailed on its race guard or its
      // dynamic import threw): report the miss so the chunks stay buffered for
      // the next flush. Dropping them here loses the bytes for good — main keeps
      // only a 64 KB pty tail, so no Refresh can bring them back.
      const handle = xterms.get(id);
      if (!handle) return false;
      // The switch-replay burst — the largest single write on the switch path,
      // and the span the renderer instrument added `timeWrite` for.
      rendererPerf.timeWrite(handle.term, data, 'transitionReplay');
      return true;
    });
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
    // Through fitWhenReady, not a bare fit(): the re-parented element is being
    // laid out against a different host this frame, which is exactly when
    // proposeDimensions returns its clamp floor.
    fitWhenReady(id);
  };

  /** Fit a session's terminal, retrying across animation frames until its host
   *  is laid out at a real size. `FitAddon.proposeDimensions()` sizes the grid
   *  from the host's computed width/height, so a fit run before the host has
   *  resolved (a freshly-shown tab whose flex box hasn't settled, a host still
   *  0-sized from a visibility transition) returns undefined / a NaN axis and
   *  `fit()` is a no-op — the grid strands at the default 80×24 inside a larger
   *  pane (the "terminal renders into a small box" bug), and nothing re-fits once
   *  the host settles. Retrying on rAF closes that so the terminal fills its host.
   *  The host's own box is measured alongside the proposal because
   *  proposeDimensions clamps a zero-height host to a finite `{cols:2, rows:1}`
   *  rather than failing; `decideFit` rejects both (see `fit-when-ready`), so a
   *  degenerate grid is never committed to the pty. A session mid-nudge is
   *  skipped: its pty is held one row short on purpose and refitting now would
   *  collapse the dip before the TUI repaints (see the Refresh nudge below). The
   *  live-handle re-read each frame drops the retry if the tab was demoted,
   *  closed, or re-mounted meanwhile. */
  const fitWhenReady = (id: string, attemptsLeft = MAX_FIT_ATTEMPTS): void => {
    const handle = xterms.get(id);
    if (!handle || nudging.isHeldBy(id, handle)) return;
    let dims: { cols: number; rows: number } | undefined;
    try {
      dims = handle.fit.proposeDimensions();
    } catch {
      dims = undefined;
    }
    // `handle.element` is the element FitAddon measures (the `.xterm-host` div it
    // was `open`ed into, i.e. `term.element.parentElement`) — read as the padding
    // box, which is why `decideFit` keeps a grid floor as well (see there).
    const action = decideFit(dims, attemptsLeft, {
      width: handle.element.clientWidth,
      height: handle.element.clientHeight,
    });
    if (action === 'retry') {
      // One retry chain per id. Callers that fire per frame (the splitter drag's
      // refit, the ResizeObserver) would otherwise each start their own 12-frame
      // chain against the same host, and `scheduleRefit`'s coalescing does not
      // reach past this call. A chain already running re-reads the host every
      // frame, so a caller that finds one pending has nothing to add.
      if (fitRetries.has(id)) return;
      fitRetries.set(
        id,
        requestAnimationFrame(() => {
          fitRetries.delete(id);
          fitWhenReady(id, attemptsLeft - 1);
        }),
      );
      return;
    }
    if (action === 'giveup') {
      // The host never resolved a usable box within the budget. The grid stays at
      // whatever it was (the 80×24 default for a fresh mount), which is a pty
      // describing a screen the user cannot see — better than committing the 2×1
      // clamp floor, but not a fitted terminal. Say so once: the field reports
      // this class arrives as "sometimes", and a silent give-up is why five
      // rounds of fixes had nothing to look at.
      console.warn(
        '[terminal] fit gave up: host never resolved a usable size',
        id,
        handle.element.clientWidth,
        handle.element.clientHeight,
      );
      return;
    }
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
        // Ask main for the pty's winsize now, concurrently with the worker
        // round-trip below, so resolving it costs no extra latency on the switch
        // path. Main owns the pty and is the only place this is known: the
        // renderer writes geometry and is never told it, the worker protocol has
        // no resize message, and nothing refits a hidden tab — so neither the
        // demoted DOM Terminal's last size nor the worker Terminal's is
        // trustworthy after the pane or window has changed size.
        // Optional-called (like `openExternal` in xterm-mount): against a preload
        // that predates the verb, a bare call throws a *synchronous* TypeError
        // that `.catch()` never sees — which would reject the whole promote and
        // leave the tab unmounted.
        const geometryPromise = Promise.resolve(window.condash.termGeometry?.(id) ?? null).catch(
          () => null,
        );
        const fromWorker = workerSessions.has(id);
        let replay: string;
        rendererPerf.count('promotes');
        if (fromWorker) {
          const rpcSpan = rendererPerf.startSpan();
          try {
            replay = await worker.serialize(id);
            rendererPerf.endSpan('workerSerialize', rpcSpan);
          } catch {
            // The round trip is timed on the failure path too: a watchdog
            // rejection at the 2 s bound is the switch-latency tail this counter
            // exists to find, and dropping it would report only the fast cases.
            rendererPerf.endSpan('workerSerialize', rpcSpan);
            rendererPerf.count('workerSerializeFailed');
            // The worker RPC failed / timed out (watchdog). Don't leave the
            // active tab blank: mount with whatever buffered tail we have so the
            // user gets a live terminal (scrollback may be lost) rather than an
            // empty pane, and the transition still clears via the finally (R1).
            replay = transitionBuffers.take(id);
          }
        } else {
          // Defensive: this tab never had a worker Terminal (shown before it was
          // ever demoted). Replay the buffered tail and drop it here so the
          // flush below does not write the same bytes a second time.
          replay = transitionBuffers.take(id);
        }
        workerSessions.delete(id);
        // The snapshot captured everything; the worker Terminal is now stale.
        // Dispose it so a hidden→shown→closed session does not leak its headless
        // Terminal (and full scrollback) in the worker for the app's lifetime.
        // Fire-and-forget, but `.catch` it: the dispose RPC can now reject via the
        // watchdog, and an unhandled rejection would spam the renderer (R1).
        if (fromWorker) void worker.dispose(id).catch(() => undefined);
        // Build the replacement Terminal at the pty's own geometry BEFORE the
        // replay is written into it. At xterm's 80×24 default the snapshot is
        // parsed at the wrong width, and the alternate buffer never reflows on
        // resize — so a full-screen TUI's frame is mangled by construction and
        // no later fit can repair it, only a repaint from the program itself.
        // That is the mechanism the repaint nudge exists to paper over.
        const geometry = (await geometryPromise) ?? undefined;
        // Span the mount only (geometry already resolved). Ended in the `finally`
        // so a mount that threw is still timed — a failed promote is exactly the
        // switch-latency tail this span exists to catch.
        const mountSpan = rendererPerf.startSpan();
        try {
          await mountForSession(mountCtx, id, col, replay, geometry);
        } finally {
          rendererPerf.endSpan('mount', mountSpan);
          const mounted = xterms.has(id);
          // The replay was consumed out of the buffer above. If no Terminal came
          // out of the mount — it threw, or it bailed on its race guard — those
          // bytes are in a local variable about to go out of scope, and main
          // keeps only a 64 KB tail. Put them back, at the front, so the next
          // promote replays them; the flush below then finds no sink and keeps
          // the lot parked (see `transition-buffers`).
          if (!mounted) transitionBuffers.restore(id, replay);
          flushTransitionBuffer(id, 'dom');
          // The frame is exact only when the snapshot's own geometry and the
          // pty's agree — then the grid we just built IS the pty's screen. If the
          // pty was resized while this tab was hidden the two differ, the
          // snapshot carries the old wrapping, and the tab still needs a real
          // repaint. A mount that produced no Terminal is never exact, and the
          // bookkeeping runs in the `finally` so a failed promote cannot strand a
          // stale `workerGeometry` entry for the next one to trust.
          const snapshotGeometry = workerGeometry.get(id);
          workerGeometry.delete(id);
          if (
            mounted &&
            geometry &&
            snapshotGeometry &&
            geometry.cols === snapshotGeometry.cols &&
            geometry.rows === snapshotGeometry.rows
          ) {
            exactHydrates.set(id, geometry);
          } else {
            exactHydrates.delete(id);
          }
        }
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
        // Settle any in-flight nudge before serializing, or the snapshot captures
        // a mid-repaint frame and the worker Terminal is built one row short.
        settleNudge(tid, h);
        // The demote serialize is synchronous main-thread work over the whole
        // scrollback — the single largest renderer frame in the 2026-07-23 CDP
        // trace (1469 ms at 8 tabs), and until now measured only in that trace.
        rendererPerf.count('demotes');
        const serializeSpan = rendererPerf.startSpan();
        const snapshot = h.serialize.serialize();
        rendererPerf.endSpan('demoteSerialize', serializeSpan);
        await worker.create(tid, h.term.cols, h.term.rows, h.term.options.scrollback as number);
        worker.write(tid, snapshot);
        workerSessions.add(tid);
        // Record the geometry this snapshot was taken at, so the promote can tell
        // an exact hydrate from a plausible one.
        workerGeometry.set(tid, { cols: h.term.cols, rows: h.term.rows });
        exactHydrates.delete(tid);
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

  /** The fields of a broadcast `TermSession` this controller consumes. Declared
   *  once and shared by `reconcile` and `queueReconcile`: when the two copies
   *  drifted, a field added to the wire (the death verdict) was silently dropped
   *  on every reload, leaving unexplained zombie rows with no Restart button. */
  type SessionSnapshot = Pick<
    TermSession,
    'id' | 'side' | 'exited' | 'repo' | 'memBytes' | 'memMaxBytes' | 'death'
  >;

  // ---- onTermSessions: single source of truth for adds/removes ----
  const reconcile = async (snap: readonly SessionSnapshot[]) => {
    const known = new Set(tabs().map((t) => t.id));
    // Columns whose active tab this pass changed, so the insert loop can nudge
    // ONCE at the end instead of once per inserted tab (see `bulkActivations`).
    const activated = new Set<Column>();
    for (const s of snap) {
      if (s.side !== 'my' || known.has(s.id)) continue;
      // Await termAttach first so that any in-flight `spawn` invoke reply has
      // resolved by the time we build the tab — `pendingSpawnIntent` is set
      // synchronously after `termSpawn` returns, and we want to read it here.
      // The geometry rides along on the same await so the raw pty tail below is
      // replayed at the size the program emitted it for, not at 80×24: after a
      // renderer reload the pty keeps whatever winsize it had, and a restored
      // full-screen tab is exactly the case that never gets a repaint nudge
      // (there is no previous active id to switch away from).
      // `termGeometry?.()` — a preload without the verb would otherwise throw
      // synchronously past `.catch()`, rejecting reconcile and leaving NO tabs
      // rendered at all.
      const [attach, geometry] = await Promise.all([
        window.condash.termAttach(s.id),
        Promise.resolve(window.condash.termGeometry?.(s.id) ?? null).catch(() => null),
      ]);
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
      transitionBuffers.drop(s.id);
      await mountForSession(mountCtx, s.id, column, attach?.output, geometry ?? undefined);
      flushTransitionBuffer(s.id, 'dom');
      // A restore hydrates the raw pty tail into a grid built at the pty's own
      // winsize, with nothing resized since — the same claim the promote path
      // makes, so record it as exact. It has to be recorded, not inferred:
      // first activations now DO get an automatic repaint (that is this
      // branch's fix), and nudging a frame that is already the pty's screen
      // shears its bottom row on the alternate buffer (that is #466's). Without
      // this the two fixes cancel out on exactly the path both were aimed at.
      if (geometry) exactHydrates.set(s.id, geometry);
      else exactHydrates.delete(s.id);
      // Bulk activation: a restore inserts N tabs and activates each one in turn,
      // so the switch detector would see N switches and queue N repaints — each
      // holding a pty one row short for 160 ms, with the next insert's promote
      // demoting the previous tab *inside* that hold (serializing a mid-repaint
      // frame into a worker Terminal one row short: the exact garbled hydrate
      // this path exists to remove). Suppress the per-insert nudge and repaint
      // once per touched column at the end, on the tab the user actually lands on.
      bulkActivations += 1;
      try {
        setActiveIn(column, s.id);
        setActiveColumn(column);
      } finally {
        bulkActivations -= 1;
      }
      activated.add(column);
      queueMicrotask(focusActive);
    }
    for (const col of activated) {
      // Resolved in the microtask, not here: a click that landed during the
      // restore has already queued its own repaint, and re-asserting the id this
      // loop saw would fight it.
      queueMicrotask(() => refreshSession(activeIdIn(col), autoRefreshOpts()));
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
        if (
          t.exited === s.exited &&
          t.memBytes === s.memBytes &&
          t.memMaxBytes === s.memMaxBytes &&
          // Compare by kind, not by object identity: main rebuilds the verdict
          // object on every broadcast, so an identity compare would allocate a
          // fresh row every 2.5 s and undo the T5 churn fix.
          t.death?.kind === s.death?.kind
        ) {
          return t;
        }
        mutated = true;
        return {
          ...t,
          exited: s.exited,
          memBytes: s.memBytes,
          memMaxBytes: s.memMaxBytes,
          death: s.death,
        };
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
      transitionBuffers.drop(id);
      workerGeometry.delete(id);
      exactHydrates.delete(id);
      // The tab is gone from the snapshot — its close has landed, so the
      // closing guard can be released (otherwise the set grows forever).
      closingTabs.delete(id);
    }
    if (toDrop.length > 0) {
      const dropped = new Set(toDrop);
      setTabs((prev) => prev.filter((t) => !dropped.has(t.id)));
      const remaining = tabs().filter((t) => t.side === 'my');
      // ONE signal write for the new active ids. Nulling the dropped ids and
      // then writing each column's fallback separately published an
      // intermediate `{left: null}`, and the auto-refresh effect reads every
      // write: it saw `previous = null` on the second one and produced no
      // repaint target, so the tab promoted in place of the closed one — the
      // neighbour after a user close, or after an agent's clean exit
      // auto-closed its tab — hydrated garbled until the user hit Refresh.
      setActiveIds((prev) => activeIdsAfterDrop(prev, remaining, dropped));
      queueMicrotask(focusActive);
    }
    // Every relation of a sid that left the roster dies with it — a closed
    // tab and a fresh boot (no live sessions) both clear their links in one
    // write. Runs on every pass because the broadcast IS the roster truth;
    // pruneLinks is idempotent and only writes when a sid actually left.
    // `restartingTabs` is exempt: a Restart's replacement-only broadcast can
    // beat the `termRestart` IPC reply, and the old sid's relations must
    // survive until repointSid moves them in the reply's success path.
    pruneLinks(new Set(snap.filter((s) => s.side === 'my').map((s) => s.id)), restartingTabs);
  };

  // Serialise reconcile passes through a promise queue: the onTermSessions
  // broadcast and the onMount termList() seed can overlap, and each pass
  // snapshots `known` at entry — two interleaved passes could otherwise both
  // insert the same session (the per-insert re-check above is the second
  // belt for anything that still slips through).
  let reconcileChain: Promise<void> = Promise.resolve();
  const queueReconcile = (snap: readonly SessionSnapshot[]): void => {
    reconcileChain = reconcileChain.then(() => reconcile(snap)).catch(() => undefined);
  };

  const offTermSessions = window.condash.onTermSessions((snap) => queueReconcile(snap));
  onCleanup(offTermSessions);

  onMount(() => {
    void window.condash.termList().then((snap) => queueReconcile(snap));
  });

  // ---- link-store focus mirror ----
  // The handle exposes only imperative `hasActive()` / `getActiveSessionId()`
  // and is a plain `let` in main.tsx, so the reactive source of truth for
  // "which tab is focused" is this controller's own signals. One effect
  // mirrors the focused session (id + display name) into the link store;
  // every consumer — the card's Link button, the Active-tab filter, the strong
  // card decoration — reads the store, nothing reaches for the handle.
  // `setActiveSession` is equality-guarded and reconcile preserves tab object
  // identity, so the 2.5 s memory-sampler broadcast does not ripple through.
  createEffect(() => {
    const sid = activeIdIn(activeColumn());
    const activeTab = sid ? tabs().find((t) => t.id === sid) : undefined;
    setActiveSession(activeTab ? { sid: activeTab.id, label: displayName(activeTab) } : null);
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
    // Anything already parked for this session must go first, or this chunk
    // jumps the queue and the terminal shows output out of order. Parked bytes
    // outlive their transition now (a flush with no destination keeps them), so
    // the steady-state branches have to consult the buffer too, not just assume
    // it is empty.
    const parked = transitionBuffers.pending(id);
    if (transitioning.has(id)) {
      transitionBuffers.buffer(id, data);
    } else if (xterms.has(id)) {
      // The visible tab's ANSI parse — the renderer's counterpart of main's
      // `logParseMs`, and the largest named cost in the renderer CDP trace.
      // Timed through the write callback: `term.write` only *queues* the parse,
      // so bracketing the call measured the enqueue and reported ~0. When bytes
      // are already parked they must go through the buffer first to keep order;
      // that path's write is timed inside `flushTransitionBuffer`.
      if (!parked) rendererPerf.timeWrite(xterms.get(id)!.term, data, 'termWrite');
      else {
        transitionBuffers.buffer(id, data);
        flushTransitionBuffer(id, 'dom');
      }
    } else if (workerSessions.has(id)) {
      if (!parked) worker.write(id, data);
      else {
        transitionBuffers.buffer(id, data);
        flushTransitionBuffer(id, 'worker');
      }
    } else {
      // Tab exists in the snapshot but has not been mounted or seeded yet
      // (race between termData and reconcile). Buffer for the first show.
      transitionBuffers.buffer(id, data);
    }
  });
  const offTermExit = window.condash.onTermExit(({ id, code, death, abnormal }) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, exited: code, death } : t)));
    // A clean `exit 0` still auto-closes: the old "[process exited 0]" marker
    // stayed around forever and forced a manual close click.
    //
    // An ABNORMAL exit keeps its row. Auto-closing it destroyed the only
    // evidence of what happened — and the Save-buffer escape hatch could not
    // fill the gap, because it needs the handle still in `xterms`, which the
    // close removes one broadcast later. The row now carries the death verdict
    // and a Restart action instead; the user closes it when they are done
    // reading. Mirrors what the Code pane already does for run rows.
    if (abnormal) return;
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
    refitAll: () => {
      for (const id of xterms.keys()) fitWhenReady(id);
    },
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
  // against its previous value fires on any change to a *different* tab —
  // including a column's first activation, which hydrates from a snapshot like
  // every other and used to be skipped — and ignores the no-op signal re-fire
  // `refreshSession` makes when it re-asserts the active id. Deferred to a
  // microtask so we don't write the active-id signal from inside an effect;
  // `refreshSession` itself decides, once the tab has hydrated, whether the
  // alt-buffer condition holds.
  let prevActive: { left: string | null; right: string | null } = { left: null, right: null };
  /** Depth of an in-progress bulk activation (`reconcile`'s insert loop). While
   *  it is non-zero the switch detector still advances `prevActive` but schedules
   *  nothing: the caller repaints once, at the end, for the tab each touched
   *  column actually lands on. */
  let bulkActivations = 0;
  /** The opts every *automatic* repaint uses — the alt-buffer opt-out applies to
   *  all of them, not just the switch path. */
  const autoRefreshOpts = (): { onlyIfAltBuffer: boolean; auto: true } => ({
    onlyIfAltBuffer: props.autoRefreshOnTabSwitch === false,
    auto: true,
  });
  createEffect(() => {
    const current = activeIds();
    const targets = refreshOnSwitchTargets(prevActive, current, props.autoRefreshOnTabSwitch);
    prevActive = { left: current.left, right: current.right };
    if (bulkActivations > 0) return;
    for (const target of targets) {
      queueMicrotask(() =>
        refreshSession(target.id, { onlyIfAltBuffer: target.onlyIfAltBuffer, auto: true }),
      );
    }
  });

  // Switching back from the Dashboard body re-shows the xterm hosts (they are
  // CSS-hidden, not unmounted, so terminals survive). xterm must refit to the
  // restored dimensions, otherwise the grid is sized for the hidden (0×0) host.
  // This also covers reopening a closed pane (`props.open` false → true), whose
  // hosts are hidden by the same CSS.
  let bandWasVisible = false;
  createEffect(() => {
    const visible = props.open && props.bottomView === 'terminal';
    // The repaint below is gated on an actual hidden→visible transition, NOT on
    // this effect running: `props.open` is `layout().terminal`, and `layout` is a
    // memo over a persisted object that `updateLayout` reallocates on every
    // patch, so the effect re-runs on every layout mutation — a sidebar toggle, a
    // splitter commit, a modal open. Repainting there would put a full SIGWINCH
    // round-trip through a live agent TUI on unrelated UI events.
    const cameIntoView = visible && !bandWasVisible;
    bandWasVisible = visible;
    if (!visible) return;
    queueMicrotask(() => {
      // The hosts were CSS-hidden while the Dashboard body showed, so the
      // just-restored host may still read 0×0 this microtask — fitWhenReady
      // retries until it is laid out rather than one-shot no-opping on it. This
      // part stays unconditional: a fit is a no-op when the grid already matches.
      for (const id of xterms.keys()) fitWhenReady(id);
      focusActive();
      if (!cameIntoView) return;
      // Neither showing the band nor reopening the pane changes an active id, so
      // the switch detector produces no target for either — yet the terminals
      // that come back into view are exactly as likely to need a repaint as one
      // switched to. Ask for them explicitly: BOTH columns, since a split shows
      // two. The reads happen here, inside the microtask, so this effect keeps
      // tracking only open/view.
      for (const col of ['left', 'right'] as Column[]) {
        refreshSession(activeIdIn(col), autoRefreshOpts());
      }
    });
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
  /** Relaunch an abnormally-exited tab in place. Main owns the respawn (it holds
   *  the original command / cwd / side and retires the dead row itself), so this
   *  only has to carry the intent across and land the replacement in the same
   *  column the dead tab occupied. */
  const restartTab = (id: string): void => {
    const tab = tabs().find((t) => t.id === id);
    if (!tab || tab.exited === undefined) return;
    // Client-side guard so a double-click doesn't fire two invokes. Main rejects
    // the second one regardless (it is the authority), but that surfaces as an
    // error toast; swallowing the duplicate here keeps the common case quiet.
    if (restartingTabs.has(id)) return;
    restartingTabs.add(id);
    setNextSpawnColumn(tab.column);
    void window.condash
      .termRestart(id)
      .then(({ id: newId }) => {
        // Carry the dead tab's presentation across so a restarted agent tab
        // doesn't lose its pinned name and reappear as a bare cwd basename.
        pendingSpawnIntent.set(newId, { label: tab.label, pinned: tab.pinned });
        setMeta(newId, { label: tab.label, column: tab.column, pinned: tab.pinned });
        // A Restart spawns a fresh session id — re-point every link relation
        // of the dead sid onto the new one so the links survive the restart.
        repointSid(id, newId);
      })
      .catch((err: unknown) => {
        // Main leaves the dead row in place when the respawn fails, so the
        // evidence stays on screen; surface why rather than failing silently.
        props.onError?.(`Could not restart the session: ${String(err)}`);
        // Reconcile's prune exempted the restarting sid, and `repointSid` (the
        // success path) is what normally ends the protection. A failure lifts
        // it with no repoint: prune against the current roster right here so
        // the old sid's relations die with a row that was actually replaced,
        // and stay with a dead row main kept. (Not in .finally: on success the
        // replacement broadcast may not have arrived yet, and pruning then
        // would drop the relations repoint just moved onto the new sid.)
        restartingTabs.delete(id);
        pruneLinks(
          new Set(
            tabs()
              .filter((t) => t.side === 'my')
              .map((t) => t.id),
          ),
        );
      })
      .finally(() => restartingTabs.delete(id));
  };

  /** Ids with a restart in flight, so a double-click can't fire two spawns. */
  const restartingTabs = new Set<string>();

  /** Test seam (mirrors `__condashXterms` / `__condashRefreshLog`): count a
   *  repaint as started or as fully finished. A Playwright test that has to
   *  observe a settled grid cannot poll the geometry for it — for the length of
   *  a nudge's hold the terminal, the pty and the frame the program painted all
   *  agree on the dipped `rows - 1`, so a mid-nudge grid reads exactly like a
   *  finished one — and it cannot wait on `__condashRefreshLog` either, which
   *  records the *start* of a nudge and says nothing about its restore. Inert
   *  unless the test opts into the registry. */
  const countRepaint = (field: 'started' | 'settled'): void => {
    if (!document.body.hasAttribute('data-test-xterm-registry')) return;
    const counts = (window.__condashRepaints ??= { started: 0, settled: 0 });
    counts[field] += 1;
  };

  /**
   * Repaint a session. `auto` marks a repaint condash asked for rather than the
   * user, and it is the single flag behind both stand-down rules: an automatic
   * request may skip a frame already proven exact (it would only shear the
   * bottom row off a correct alternate-screen frame), and may skip a nudge
   * already in flight for the same terminal. A *manual* Refresh does neither —
   * the user pressing it IS the signal that the screen is wrong, whatever the
   * geometry says, so it is unconditional and, if a hold is in flight, queued
   * behind it rather than dropped.
   */
  const refreshSession = (
    id: string | null,
    opts?: { onlyIfAltBuffer?: boolean; auto?: boolean },
  ): void => {
    if (!id) return;
    const tab = tabs().find((t) => t.id === id);
    if (!tab) return;
    countRepaint('started');
    /** Record this repaint as finished, once. Every exit path below calls it —
     *  including the nudge's timers and the chain's error tail — so a test
     *  waiting for the counters to balance can never hang on a repaint that has
     *  in fact stopped. */
    let counted = false;
    const markSettled = (): void => {
      if (counted) return;
      counted = true;
      countRepaint('settled');
    };
    // Promote the session to its column's active DOM Terminal so there is a live
    // terminal to resize — but only when it isn't already active. Re-asserting an
    // unchanged active id still allocates a new signal object, which re-runs the
    // focus effect → a chained `syncVisibility` → `focusActiveDom`, and that
    // extra fit is exactly what used to collapse the nudge dip.
    if (activeIdIn(tab.column) !== id) setActiveIn(tab.column, id);
    if (activeColumn() !== tab.column) setActiveColumn(tab.column);
    // The handle this pass claimed the nudge for, so the error path releases its
    // own claim and never a later handle's.
    let claimed: XtermHandle | undefined;
    // Chain after any in-flight promote/demote so the DOM Terminal for this
    // session exists before we resize it, then wait one animation frame so the
    // host layout can settle before the nudge starts.
    visibilityChain = visibilityChain
      .then(async () => {
        await syncVisibility();
        // Give the host one animation frame to settle before the nudge begins.
        // The visibility transition just promoted the tab and started a
        // fitWhenReady retry; if the nudge starts immediately it claims the
        // handle in `nudging`, which cancels that retry and leaves a terminal
        // that has not reached its real size. A short beat lets the fit finish
        // before we deliberately resize the terminal one row shorter.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const handle = xterms.get(id);
        // The pure decision: skip (no live terminal — demoted / closed /
        // re-mounted mid-hydration), focus-only (the alt-buffer opt-out excluded a
        // faithfully-hydrated shell, or the terminal is too short to give up a
        // row), or nudge. `bufferType` is read post-hydrate so it reflects the
        // snapshot just replayed.
        // The frame is still exact only if nothing has resized the grid since the
        // hydrate — a fit to a differently-sized host means the pty geometry
        // changed under it and the frame does need a repaint.
        const exact = exactHydrates.get(id);
        const action = decideRefreshAction({
          mounted: Boolean(handle),
          bufferType: handle?.term.buffer.active.type,
          rows: handle?.term.rows,
          onlyIfAltBuffer: opts?.onlyIfAltBuffer ?? false,
          frameIsExact: Boolean(
            handle && exact && handle.term.cols === exact.cols && handle.term.rows === exact.rows,
          ),
          // Only an automatic repaint may stand down on an exact frame — see the
          // `auto` note on `refreshSession`. Deriving it from the same flag is
          // what keeps the two automatic callers this branch adds (the
          // end-of-restore repaint and the band flip) from shearing a frame that
          // is already the pty's screen.
          allowExactSkip: opts?.auto ?? false,
        });
        if (action.kind === 'skip') {
          markSettled();
          return;
        }
        // Past `skip`, `decideRefreshAction` guarantees a live handle; bind it
        // non-nullable so the deferred restore below narrows cleanly.
        const live = handle!;
        if (action.kind === 'focus-only') {
          // `altGate`: the opt-out excluded a faithfully-hydrated shell.
          // `tooShort`: a ≤1-row terminal can't lose a row.
          // `frameExact`: the grid already IS the pty's screen; nudging it would
          // only shear its bottom row (automatic repaints only).
          live.term.focus();
          markSettled();
          return;
        }
        // A nudge is already holding this exact terminal one row short — two
        // refreshes raced for it (clicking a tab while the Dashboard shows asks
        // via both the switch and the band flip; the context-menu Refresh
        // re-asserts the active id and re-enters through the switch effect).
        // Dipping again only takes another row and lets the first timer restore
        // early; the hold already in flight is the one the TUI samples.
        if (nudging.isHeldBy(id, live)) {
          // An automatic request adds nothing to a repaint already in flight. A
          // *user* one must never be swallowed — this whole bug class is "I had
          // to press Refresh", so a press that lands mid-hold has to queue behind
          // it rather than disappear.
          if (!opts?.auto) setTimeout(() => refreshSession(id, opts), REPAINT_NUDGE_MS);
          // The requeued press counts as its own repaint when it runs; this one
          // resized nothing and is done.
          markSettled();
          return;
        }
        // Committed to the nudge. Test seam (mirrors `__condashXterms`): recorded
        // below the gates, so the log only ever names a repaint that really ran —
        // above them it also named alt-gated, too-short and already-held passes
        // that resized nothing. Inert unless the test opts into the registry.
        if (document.body.hasAttribute('data-test-xterm-registry')) {
          (window.__condashRefreshLog ??= []).push(id);
        }
        // Hold the pty one row short across REPAINT_NUDGE_MS so a debounced TUI
        // samples the smaller size and repaints; `nudging` keeps a competing fit
        // from restoring the size early (see `focusActiveDom`).
        const { cols, rows } = live.term;
        claimed = live;
        nudging.claim(id, live);
        live.term.resize(cols, rows - 1);
        setTimeout(() => {
          // Release only our own claim: by now the session may have been demoted
          // and re-promoted onto a NEW handle that is mid-nudge itself, and
          // clearing that one's guard would let a chained fit restore the size
          // and collapse its dip.
          nudging.release(id, live);
          // Bail if the tab was demoted, closed, or re-mounted while we waited.
          if (xterms.get(id) !== live) {
            markSettled();
            return;
          }
          // Give the row back explicitly first. The restore used to be the fit
          // alone, which meant a host that never resolved a usable box (the fit
          // gives up) left the terminal — and the pty — permanently one row
          // shorter than before the repaint: the nudge became the damage.
          try {
            live.term.resize(cols, rows);
          } catch {
            /* term disposed */
          }
          // Then fitWhenReady (not a bare fit) so the true size still lands even
          // if the host was not laid out at REPAINT_NUDGE_MS — it retries across
          // frames instead of no-opping and stranding the grid.
          fitWhenReady(id);
          // One more delayed fit as a backstop: the host may settle a frame or
          // two after the nudge window, or a ResizeObserver callback may have
          // fired while `nudging` blocked it and will not fire again (the host
          // size did not change). The second attempt is a no-op if the first
          // restore already succeeded.
          setTimeout(() => {
            if (xterms.get(id) === live) fitWhenReady(id);
            // The last scheduled effect of this repaint has run: nothing else
            // will move this grid on its account.
            markSettled();
          }, 150);
          try {
            live.term.focus();
          } catch {
            /* term disposed */
          }
        }, REPAINT_NUDGE_MS);
      })
      .catch(() => {
        if (claimed) nudging.release(id, claimed);
        markSettled();
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
    sessionLabel: (sid) => {
      const tab = tabs().find((t) => t.id === sid);
      return tab ? displayName(tab) : null;
    },
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
    restartTab,
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
