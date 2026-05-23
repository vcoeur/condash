// Bottom "My terms" pane.
//
// Architecture:
// - Single source of truth: `onTermSessions` from main is the only path that
//   adds / removes Tab rows + xterms. Local spawn() just calls termSpawn and
//   stashes a label in localStorage; the broadcast that follows fills in the
//   tab. This avoids the duplicate-tab race that the previous version had.
// - Single-column default: the bottom pane shows one tab strip + one xterm
//   host. The right column only materialises when at least one tab lives in
//   it (created from the right's `+` button or dragged across from the left).
// - Cross-column drag-and-drop. While dragging, a drop strip appears on the
//   right edge so the user can promote a single-column layout to split.
// - The pane is **always mounted** even when collapsed, so spawn() callers
//   from elsewhere in the renderer always have a `terminalHandle` available.
//   Visual collapse is just a CSS `closed` modifier that hides the body.
// - A draggable splitter sets the column width ratio (only when split).
// - A draggable handle on the pane's top edge sets the pane height.

import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { AgentListItem } from '@shared/harnesses';
import type { TermSide, TermSpawnRequest, TerminalPrefs, TerminalXtermPrefs } from '@shared/types';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { mountXterm, type MountedTerm } from './xterm-mount';
import { TerminalColumn } from './terminal-pane/column';
import { createDragDropController, DRAG_MIME } from './terminal-pane/drag-drop';
import {
  DEFAULT_PANE_HEIGHT,
  DEFAULT_SPLIT_RATIO,
  deleteMeta,
  readLayout,
  readMeta,
  setMeta,
} from './terminal-pane/persistence';
import { createResizeHandlers } from './terminal-pane/resize';
import { createSearchController } from './terminal-pane/search';
import { type Column, displayName, type Tab } from './terminal-pane/types';
import './terminal-pane.css';

export type { Column, Tab } from './terminal-pane/types';

export interface SpawnOptions {
  /** Lock the tab title to `label` so OSC 7 cwd updates from the shell
   *  don't override it. Default false (current "+" new-shell behavior). */
  pinned?: boolean;
}

/** Spawn-time agent selector. Passing an `AgentListItem` pins the tab label to
 *  the agent name and runs that agent (`<harness>-<model_variant>`); passing
 *  `null` is the plain `+` behaviour (no command, unpinned label tracking
 *  OSC 7 cwd). */
export type AgentChoice = AgentListItem | null;

export interface TerminalPaneHandle {
  spawn(request: TermSpawnRequest, label: string, opts?: SpawnOptions): Promise<string>;
  switchTo(side: TermSide, id?: string): void;
  /** Add a fresh user shell tab to "My terms". `agent` may be an
   *  `AgentListItem` to pin and run that agent, or `null` for a plain shell.
   *  `initialPrompt` is passed through to `TermSpawnRequest` so harnesses that
   *  support it (claude, opencode) receive the prompt as a CLI argument. */
  spawnUserShell(agent?: AgentChoice, side?: TermSide, initialPrompt?: string): Promise<string>;
  /** Move the active tab within its column strip. */
  moveActiveTab(direction: -1 | 1): void;
  /** Type a literal string into the active terminal (no shell parsing). */
  typeIntoActive(text: string): void;
  /** True when there is an active session in the active column. */
  hasActive(): boolean;
  /** Return the active session ID for the active column, or null. */
  getActiveSessionId(): string | null;
  /** Wait until the accumulated output for `sessionId` matches `pattern`,
   *  or reject after `timeoutMs` (default 15 s). Resolves immediately if
   *  the pattern already matches. ANSI escape sequences are stripped before
   *  matching so patterns can target visible text only. */
  waitForReady(sessionId: string, pattern: RegExp, timeoutMs?: number): Promise<void>;
}

export function TerminalPane(props: {
  open: boolean;
  onClose: () => void;
  /** Toggle the pane open / closed. Used by the in-strip Terminal
   *  handle which is visible whether the body is shown or not. */
  onTogglePane: () => void;
  registerHandle: (handle: TerminalPaneHandle | null) => void;
  /** Agents defined under `<conception>/agents/`. Each renders as an option
   *  in the tab-strip spawn dropdown (alongside "New shell"). */
  agents: readonly AgentListItem[];
  /** Working directory passed to spawned user shells (typically the
   * conception path). */
  cwd?: string | null;
  /** User-configured xterm preferences (font, colours, scrollback, …). Pulled
   *  from condash.json under `terminal.xterm`. Undefined = defaults. */
  xtermPrefs?: TerminalXtermPrefs;
}) {
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
  // user-initiated close (× button) and process-exit close don't race.
  const closingTabs = new Set<string>();

  // Accumulated raw pty output per session (ANSI codes included). Used by
  // waitForReady to detect agent prompt markers without re-parsing xterm buffers.
  const sessionData = new Map<string, string>();

  // Pending readiness waiters keyed by session id.
  const readyWaiters = new Map<
    string,
    {
      pattern: RegExp;
      resolve: () => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }[]
  >();

  const stripAnsi = (text: string): string =>
    text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][0-9;]*[^\x07]*\x07/g, '');

  const checkReadyWaiters = (sessionId: string): void => {
    const waiters = readyWaiters.get(sessionId);
    if (!waiters || waiters.length === 0) return;
    const raw = sessionData.get(sessionId) || '';
    const cleaned = stripAnsi(raw);
    const remaining = waiters.filter((w) => {
      if (w.pattern.test(cleaned)) {
        clearTimeout(w.timer);
        w.resolve();
        return false;
      }
      return true;
    });
    if (remaining.length === 0) {
      readyWaiters.delete(sessionId);
      sessionData.delete(sessionId);
    } else {
      readyWaiters.set(sessionId, remaining);
    }
  };

  const xterms = new Map<
    string,
    {
      term: Terminal;
      fit: FitAddon;
      search: SearchAddon;
      serialize: SerializeAddon;
      mounted: MountedTerm;
      element: HTMLDivElement;
      column: Column;
      detachListeners?: () => void;
    }
  >();
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

  /** Mount an xterm element into the host of its column. */
  const mountForSession = (id: string, column: Column, replay?: string): void => {
    if (xterms.has(id)) return;
    const element = document.createElement('div');
    element.className = 'xterm-host';
    element.style.display = 'none';
    const host = hostFor(column);
    if (host) host.appendChild(element);
    if (replay) {
      const prev = sessionData.get(id) || '';
      sessionData.set(id, prev + replay);
    }
    const mounted = mountXterm(element, id, {
      replay,
      prefs: props.xtermPrefs,
      onCustomKey: (ev) => handleXtermKey(ev, id),
    });
    const handleEntry: {
      term: Terminal;
      fit: FitAddon;
      search: SearchAddon;
      serialize: SerializeAddon;
      mounted: MountedTerm;
      element: HTMLDivElement;
      column: Column;
      detachListeners?: () => void;
    } = {
      term: mounted.term,
      fit: mounted.fit,
      search: mounted.search,
      serialize: mounted.serialize,
      mounted,
      element,
      column,
    };
    xterms.set(id, handleEntry);
    // Promote this tab to active when the user clicks/focuses inside the
    // xterm (otherwise typing into it works but the tab strip's "active"
    // styling stays on whichever tab last got a click).
    const promote = () => {
      // `xterms.get(id)?.column` so a tab that's been moved between columns
      // still resolves to its current side.
      const col = xterms.get(id)?.column ?? column;
      if (activeIdIn(col) !== id) setActiveIn(col, id);
      if (activeColumn() !== col) setActiveColumn(col);
    };
    element.addEventListener('focusin', promote);
    element.addEventListener('mousedown', promote);
    // Stash a per-mount detacher so dispose() drops the listeners along
    // with the rest of the xterm. Without it, repeated open/close churn
    // leaves dead `promote` closures pinned to the host element via
    // bubble-listener references the GC can't reach.
    handleEntry.detachListeners = () => {
      element.removeEventListener('focusin', promote);
      element.removeEventListener('mousedown', promote);
    };
    // Track cwd updates from OSC 7 → reflect in the tab label.
    mounted.onCwdChange((cwd) => {
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, cwd } : t)));
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
    try {
      handle.fit.fit();
    } catch {
      /* not yet sized */
    }
  };

  const focusActive = (): void => {
    for (const col of ['left', 'right'] as Column[]) {
      const id = activeIdIn(col);
      for (const [tid, h] of xterms) {
        if (h.column !== col) continue;
        h.element.style.display = tid === id ? 'flex' : 'none';
      }
    }
    const id = activeIdIn(activeColumn());
    if (!id) return;
    const handle = xterms.get(id);
    if (handle) {
      try {
        handle.fit.fit();
      } catch {
        /* not yet sized */
      }
      handle.term.focus();
    }
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

  // ---- onTermSessions: single source of truth for adds/removes ----
  const reconcile = async (
    snap: readonly { id: string; side: TermSide; exited?: number; repo?: string }[],
  ) => {
    const known = new Set(tabs().map((t) => t.id));
    for (const s of snap) {
      if (s.side !== 'my' || known.has(s.id)) continue;
      // Await termAttach first so that any in-flight `spawn` invoke reply has
      // resolved by the time we build the tab — `pendingSpawnIntent` is set
      // synchronously after `termSpawn` returns, and we want to read it here.
      const attach = await window.condash.termAttach(s.id);
      const intent = pendingSpawnIntent.get(s.id);
      pendingSpawnIntent.delete(s.id);
      const meta = readMeta()[s.id];
      const label = intent?.label ?? meta?.label ?? (s.repo ? `${s.repo} (run)` : 'shell');
      const column: Column = meta?.column ?? nextSpawnColumn;
      nextSpawnColumn = 'left';
      const pinned = intent?.pinned ?? meta?.pinned;
      const tab: Tab = {
        id: s.id,
        side: 'my',
        column,
        label,
        customName: meta?.customName,
        pinned,
        exited: s.exited,
      };
      setTabs((prev) => [...prev, tab]);
      setMeta(s.id, { label, customName: meta?.customName, column, pinned });
      mountForSession(s.id, column, attach?.output);
      setActiveIn(column, s.id);
      setActiveColumn(column);
      queueMicrotask(focusActive);
    }
    setTabs((prev) =>
      prev.map((t) => {
        const s = snap.find((x) => x.id === t.id);
        return s ? { ...t, exited: s.exited } : t;
      }),
    );
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
      sessionData.delete(id);
      const waiters = readyWaiters.get(id);
      if (waiters) {
        for (const w of waiters) {
          clearTimeout(w.timer);
          w.reject(new Error('Session closed'));
        }
        readyWaiters.delete(id);
      }
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

  const offTermSessions = window.condash.onTermSessions((snap) => void reconcile(snap));
  onCleanup(offTermSessions);

  onMount(() => {
    void window.condash.termList().then((snap) => void reconcile(snap));
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
    initialPrompt?: string,
  ): Promise<string> => {
    const label = uniqueLabel(agent?.name || 'shell');
    // Pin the label only when the caller picked an agent. The bare "New shell"
    // path leaves the tab unpinned so the shell's OSC 7 cwd basename drives the
    // displayed title.
    return spawn(
      {
        side: sd,
        agentSlug: agent?.slug,
        cwd: props.cwd ?? undefined,
        initialPrompt,
      },
      label,
      { pinned: agent !== null },
    );
  };

  /** Resolve an agent slug (or null) to its `AgentListItem` from props.agents.
   *  Returns null for a missing slug — callers treat that as the plain
   *  `New shell` path. */
  const resolveAgent = (slug: string | null): AgentChoice => {
    if (slug === null) return null;
    return props.agents.find((a) => a.slug === slug) ?? null;
  };

  // ---- live data + exit notification ----
  const offTermData = window.condash.onTermData(({ id, data }) => {
    const prev = sessionData.get(id) || '';
    sessionData.set(id, prev + data);
    checkReadyWaiters(id);
    const handle = xterms.get(id);
    handle?.term.write(data);
  });
  const offTermExit = window.condash.onTermExit(({ id, code: _code }) => {
    // Auto-close the tab on process exit — the previous "[process exited N]"
    // marker stayed around forever and forced a manual click on the close
    // button. If the user wants to inspect the buffer, the Save-buffer
    // button on the tab strip dumps it to a .txt before close lands.
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, exited: _code } : t)));
    if (!closingTabs.has(id)) closeTab(id);
  });
  onCleanup(() => {
    offTermData();
    offTermExit();
    for (const [, { mounted, element, detachListeners }] of xterms) {
      detachListeners?.();
      mounted.dispose();
      element.remove();
    }
    xterms.clear();
    for (const waiters of readyWaiters.values()) {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error('Pane closed'));
      }
    }
    readyWaiters.clear();
    sessionData.clear();
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

  createEffect(() => {
    void activeIds();
    void activeColumn();
    void isSplit();
    queueMicrotask(focusActive);
  });
  createEffect(() => {
    if (props.open) queueMicrotask(focusActive);
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
    waitForReady: (sessionId, pattern, timeoutMs = 15000) =>
      new Promise<void>((resolve, reject) => {
        const raw = sessionData.get(sessionId) || '';
        if (pattern.test(stripAnsi(raw))) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          const waiters = readyWaiters.get(sessionId);
          if (waiters) {
            const filtered = waiters.filter((w) => w.resolve !== resolve);
            if (filtered.length === 0) readyWaiters.delete(sessionId);
            else readyWaiters.set(sessionId, filtered);
          }
          reject(new Error(`Timed out waiting for agent prompt (${timeoutMs}ms)`));
        }, timeoutMs);
        const entry = { pattern, resolve, reject, timer };
        const existing = readyWaiters.get(sessionId) || [];
        readyWaiters.set(sessionId, [...existing, entry]);
      }),
  };
  onMount(() => props.registerHandle(handle));
  onCleanup(() => props.registerHandle(null));

  const renderColumn = (col: Column) => (
    <TerminalColumn
      col={col}
      tabs={tabsIn(col)}
      activeId={activeIdIn(col)}
      isActiveColumn={activeColumn() === col}
      renamingId={renamingId()}
      agents={props.agents}
      paneOpen={props.open}
      dnd={dnd}
      registerHost={(c, el) => {
        if (c === 'left') leftHost = el;
        else rightHost = el;
      }}
      onActivateColumn={setActiveColumn}
      onActivateTab={(c, id) => {
        setActiveIn(c, id);
        setActiveColumn(c);
      }}
      onRequestRename={setRenamingId}
      onCommitRename={commitRename}
      onCancelRename={() => setRenamingId(null)}
      onCloseTab={closeTab}
      onSpawnShell={(c, agentSlug) => {
        nextSpawnColumn = c;
        setActiveColumn(c);
        void spawnUserShell(resolveAgent(agentSlug), 'my');
      }}
      onSaveBuffer={(c) => {
        setActiveColumn(c);
        saveActiveBuffer();
      }}
      onOpenSearch={(c) => {
        setActiveColumn(c);
        search.openSearch();
      }}
      onTogglePane={() => props.onTogglePane()}
    />
  );

  let columnsRoot: HTMLDivElement | undefined;

  return (
    <section
      class="terminal-pane"
      classList={{ closed: !props.open }}
      style={{ height: `${paneHeight()}px` }}
    >
      <Show when={props.open}>
        <div
          class="terminal-pane-resize"
          onMouseDown={(e) => resize.startHeightDrag(e)}
          title="Drag to resize"
        />
      </Show>
      <div
        class="terminal-columns"
        ref={(el) => (columnsRoot = el)}
        classList={{ split: isSplit() }}
        style={
          isSplit()
            ? {
                'grid-template-columns': `${splitRatio() * 100}% 4px ${(1 - splitRatio()) * 100}%`,
              }
            : undefined
        }
      >
        {renderColumn('left')}
        <Show when={isSplit()}>
          <div
            class="terminal-splitter"
            onMouseDown={(e) => columnsRoot && resize.startSplitterDrag(e, columnsRoot)}
            title="Drag to resize columns"
          />
          {renderColumn('right')}
        </Show>
        {/* When unsplit and a tab is being dragged, expose a thin drop zone on
            the right edge — dropping there promotes the layout to split. */}
        <Show when={!isSplit() && dnd.draggingId() !== null}>
          <div
            class="terminal-split-dropzone"
            classList={{
              hover: dnd.dropTarget().column === 'right',
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              dnd.setDropTarget({ id: null, column: 'right' });
            }}
            onDragLeave={() => {
              if (dnd.dropTarget().column === 'right' && dnd.dropTarget().id === null) {
                dnd.setDropTarget({ id: null, column: null });
              }
            }}
            onDrop={(e) => dnd.onDropOnStrip(e, 'right')}
          >
            <span>Drop to split →</span>
          </div>
        </Show>
      </div>
      {search.SearchBar()}
    </section>
  );
}

// Re-export for callers that destructure both surface types together.
export type { TerminalPrefs };

// Defaults re-exported for unit tests that need to reach for them.
export { DEFAULT_PANE_HEIGHT, DEFAULT_SPLIT_RATIO };
