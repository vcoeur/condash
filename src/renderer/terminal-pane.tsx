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

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { TermSide, TermSpawnRequest, TerminalPrefs, TerminalXtermPrefs } from '@shared/types';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { mountXterm, type MountedTerm } from './xterm-mount';
import './terminal-pane.css';

export type Column = 'left' | 'right';

export interface Tab {
  id: string;
  /** Server-side `my` for tabs in this pane (code-side sessions live on the
   * Code tab). Kept on the Tab object so the structure stays mirror-able. */
  side: TermSide;
  /** Renderer-only column choice within the bottom pane. */
  column: Column;
  /** Default label (auto-derived from spawn — e.g. repo name or shell). */
  label: string;
  /** User-renamed label, if any. Persisted by id in localStorage. */
  customName?: string;
  /** Most recent cwd reported via OSC 7 (`file://host/path`). Used for the
   *  display label when the user hasn't supplied a custom name. */
  cwd?: string;
  /** Process exit code; the tab can still be cleared via close. */
  exited?: number;
}

interface PersistedTabMeta {
  label: string;
  customName?: string;
  column: Column;
}

interface PersistedLayout {
  paneHeight: number;
  splitRatio: number;
}

const META_KEY = 'condash-term-meta';
const LAYOUT_KEY = 'condash-term-layout';
const DEFAULT_PANE_HEIGHT = 280;
const DEFAULT_SPLIT_RATIO = 0.5;
const MIN_PANE_HEIGHT = 120;
const MAX_PANE_HEIGHT_VH = 0.85;
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;

function readMeta(): Record<string, PersistedTabMeta> {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as Record<string, PersistedTabMeta>) : {};
  } catch {
    return {};
  }
}
function writeMeta(meta: Record<string, PersistedTabMeta>): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* ignore */
  }
}
function setMeta(id: string, value: PersistedTabMeta): void {
  const map = readMeta();
  map[id] = value;
  writeMeta(map);
}
function deleteMeta(id: string): void {
  const map = readMeta();
  delete map[id];
  writeMeta(map);
}

function readLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { paneHeight: DEFAULT_PANE_HEIGHT, splitRatio: DEFAULT_SPLIT_RATIO };
    const parsed = JSON.parse(raw) as Partial<PersistedLayout>;
    return {
      paneHeight: typeof parsed.paneHeight === 'number' ? parsed.paneHeight : DEFAULT_PANE_HEIGHT,
      splitRatio: typeof parsed.splitRatio === 'number' ? parsed.splitRatio : DEFAULT_SPLIT_RATIO,
    };
  } catch {
    return { paneHeight: DEFAULT_PANE_HEIGHT, splitRatio: DEFAULT_SPLIT_RATIO };
  }
}
function writeLayout(layout: PersistedLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

export interface TerminalPaneHandle {
  spawn(request: TermSpawnRequest, label: string): Promise<string>;
  switchTo(side: TermSide, id?: string): void;
  /** Add a fresh user shell tab to "My terms". */
  spawnUserShell(launcherCommand?: string | null, side?: TermSide): Promise<string>;
  /** Move the active tab within its column strip. */
  moveActiveTab(direction: -1 | 1): void;
  /** Type a literal string into the active terminal (no shell parsing). */
  typeIntoActive(text: string): void;
  /** True when there is an active session in the active column. */
  hasActive(): boolean;
}

const DRAG_MIME = 'application/x-condash-term-tab';

/** Display name for a tab. Custom rename wins; otherwise the cwd basename if
 *  the shell emitted OSC 7; otherwise the spawn-time label. */
function displayName(tab: Tab): string {
  if (tab.customName) return tab.customName;
  if (tab.cwd) {
    const basename = tab.cwd.split('/').filter(Boolean).pop();
    if (basename) return basename;
  }
  return tab.label;
}

export function TerminalPane(props: {
  open: boolean;
  onClose: () => void;
  registerHandle: (handle: TerminalPaneHandle | null) => void;
  /** Optional launcher command (e.g. `claude`). When set, a second `+` button
   * spawns a shell that runs this command. */
  launcherCommand?: string | null;
  /** Working directory passed to spawned user shells (typically the
   * conception path). */
  cwd?: string | null;
  /** User-configured xterm preferences (font, colours, scrollback, …). Pulled
   *  from configuration.json under `terminal.xterm`. Undefined = defaults. */
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

  // In-flight search bar state.
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');

  // Track the column where the next default-spawn should land — set when the
  // user clicks a `+` button so that the right column's `+` lands a tab in
  // the right column, not always 'left'.
  let nextSpawnColumn: Column = 'left';

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
    const mounted = mountXterm(element, id, {
      replay,
      prefs: props.xtermPrefs,
      onCustomKey: (ev) => handleXtermKey(ev, id),
    });
    const handleEntry = {
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

  /** Custom-key hook for xterm — handles Ctrl+F (search), Ctrl+Up/Down (jump
   *  to prompt) before the bytes hit the shell. */
  const handleXtermKey = (ev: KeyboardEvent, _id: string): boolean => {
    const ctrl = ev.ctrlKey && !ev.metaKey && !ev.altKey;
    if (!ctrl || ev.type !== 'keydown') return true;
    if (!ev.shiftKey && (ev.key === 'f' || ev.key === 'F')) {
      ev.preventDefault();
      setSearchOpen(true);
      queueMicrotask(() => searchInputRef?.focus());
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
      const meta = readMeta()[s.id];
      const label = meta?.label ?? (s.repo ? `${s.repo} (run)` : 'shell');
      const column: Column = meta?.column ?? nextSpawnColumn;
      nextSpawnColumn = 'left';
      const tab: Tab = {
        id: s.id,
        side: 'my',
        column,
        label,
        customName: meta?.customName,
        exited: s.exited,
      };
      setTabs((prev) => [...prev, tab]);
      setMeta(s.id, { label, customName: meta?.customName, column });
      const attach = await window.condash.termAttach(s.id);
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
      handle?.mounted.dispose();
      handle?.element.remove();
      xterms.delete(id);
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

  const spawn = async (request: TermSpawnRequest, label: string): Promise<string> => {
    const { id } = await window.condash.termSpawn(request);
    setMeta(id, { label, column: nextSpawnColumn });
    return id;
  };

  const spawnUserShell = async (
    launcherCommand?: string | null,
    sd: TermSide = 'my',
  ): Promise<string> => {
    const base = launcherCommand?.trim() || 'shell';
    const label = uniqueLabel(base);
    return spawn(
      {
        side: sd,
        command: launcherCommand?.trim() || undefined,
        cwd: props.cwd ?? undefined,
      },
      label,
    );
  };

  // ---- live data + exit notification ----
  const offTermData = window.condash.onTermData(({ id, data }) => {
    const handle = xterms.get(id);
    handle?.term.write(data);
  });
  const offTermExit = window.condash.onTermExit(({ id, code: _code }) => {
    // Auto-close the tab on process exit — the previous "[process exited N]"
    // marker stayed around forever and forced a manual click on the close
    // button. If the user wants to inspect the buffer, the Save-buffer
    // button on the tab strip dumps it to a .txt before close lands.
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, exited: _code } : t)));
    closeTab(id);
  });
  onCleanup(() => {
    offTermData();
    offTermExit();
    for (const [, { mounted, element }] of xterms) {
      mounted.dispose();
      element.remove();
    }
    xterms.clear();
  });

  const closeTab = (id: string) => {
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
      });
    }
    setRenamingId(null);
  };

  // ---- column / pane resize ----
  const persistLayout = () => {
    writeLayout({ paneHeight: paneHeight(), splitRatio: splitRatio() });
  };

  const startSplitterDrag = (startEvent: MouseEvent, container: HTMLElement) => {
    startEvent.preventDefault();
    const rect = container.getBoundingClientRect();
    const onMove = (e: MouseEvent) => {
      const ratio = (e.clientX - rect.left) / rect.width;
      const clamped = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
      setSplitRatio(clamped);
      for (const { fit } of xterms.values()) {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      persistLayout();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startHeightDrag = (startEvent: MouseEvent) => {
    startEvent.preventDefault();
    const startY = startEvent.clientY;
    const startHeight = paneHeight();
    const maxHeight = Math.floor(window.innerHeight * MAX_PANE_HEIGHT_VH);
    const onMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      const next = Math.max(MIN_PANE_HEIGHT, Math.min(maxHeight, startHeight + delta));
      setPaneHeight(next);
      for (const { fit } of xterms.values()) {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      persistLayout();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onWindowResize = (): void => {
    for (const { fit } of xterms.values()) {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    }
  };
  onMount(() => window.addEventListener('resize', onWindowResize));
  onCleanup(() => window.removeEventListener('resize', onWindowResize));

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
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<{
    id: string | null;
    column: Column | null;
  }>({ id: null, column: null });
  const clearDragState = () => {
    setDraggingId(null);
    setDropTarget({ id: null, column: null });
  };

  const onDragStart = (e: DragEvent, id: string) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(id);
  };
  const onDragEndTab = () => clearDragState();
  const onDragOverTab = (e: DragEvent, targetId: string, targetColumn: Column) => {
    if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget({ id: targetId, column: targetColumn });
  };
  const onDragOverStrip = (e: DragEvent, column: Column) => {
    if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropTarget().id === null || dropTarget().column !== column) {
      setDropTarget({ id: null, column });
    }
  };
  const onDragLeaveStrip = (e: DragEvent, column: Column) => {
    const related = e.relatedTarget as HTMLElement | null;
    const strip = e.currentTarget as HTMLElement;
    if (related && strip.contains(related)) return;
    if (dropTarget().column === column) setDropTarget({ id: null, column: null });
  };
  const onDropOnTab = (e: DragEvent, targetId: string, targetColumn: Column) => {
    e.preventDefault();
    const srcId = e.dataTransfer?.getData(DRAG_MIME);
    clearDragState();
    if (!srcId || srcId === targetId) return;
    moveTab(srcId, { beforeId: targetId, column: targetColumn });
  };
  const onDropOnStrip = (e: DragEvent, column: Column) => {
    e.preventDefault();
    const srcId = e.dataTransfer?.getData(DRAG_MIME);
    clearDragState();
    if (!srcId) return;
    moveTab(srcId, { column });
  };

  /** Move tab `srcId`. If `beforeId` set, insert before that tab; else append
   * to the end of `column`'s strip. Updates xterm host parent if the column
   * changed. */
  const moveTab = (srcId: string, target: { beforeId?: string; column: Column }) => {
    setTabs((prev) => {
      const list = prev.slice();
      const srcIdx = list.findIndex((t) => t.id === srcId);
      if (srcIdx === -1) return prev;
      const [moved] = list.splice(srcIdx, 1);
      const repositioned: Tab = { ...moved, column: target.column };
      if (target.beforeId) {
        const tgtIdx = list.findIndex((t) => t.id === target.beforeId);
        if (tgtIdx === -1) {
          list.push(repositioned);
        } else {
          list.splice(tgtIdx, 0, repositioned);
        }
      } else {
        list.push(repositioned);
      }
      return list;
    });
    // Wait for the right column to mount if it didn't exist before (split just
    // got promoted by this drop) — host elements register on render.
    queueMicrotask(() => {
      movemount(srcId, target.column);
      const tab = tabs().find((t) => t.id === srcId);
      if (tab)
        setMeta(srcId, { label: tab.label, customName: tab.customName, column: target.column });
      setActiveIn(target.column, srcId);
      setActiveColumn(target.column);
      queueMicrotask(focusActive);
    });
  };

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

  // ---- in-pane search (xterm addon-search) ----
  let searchInputRef: HTMLInputElement | undefined;
  const runSearch = (direction: 'next' | 'prev'): void => {
    const id = activeIdIn(activeColumn());
    if (!id) return;
    const handle = xterms.get(id);
    if (!handle) return;
    const q = searchQuery();
    if (!q) return;
    if (direction === 'next') handle.search.findNext(q);
    else handle.search.findPrevious(q);
  };
  const closeSearch = (): void => {
    setSearchOpen(false);
    setSearchQuery('');
    queueMicrotask(focusActive);
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
    },
    hasActive: () => Boolean(activeIdIn(activeColumn())),
  };
  onMount(() => props.registerHandle(handle));
  onCleanup(() => props.registerHandle(null));

  // ---- render helpers ----
  const renderColumn = (col: Column) => {
    const isActiveCol = (): boolean => activeColumn() === col;
    return (
      <div class="terminal-column" classList={{ active: isActiveCol() }}>
        <div
          class="terminal-tabs"
          classList={{
            'drop-strip-target':
              draggingId() !== null && dropTarget().column === col && dropTarget().id === null,
          }}
          onDragOver={(e) => onDragOverStrip(e, col)}
          onDragLeave={(e) => onDragLeaveStrip(e, col)}
          onDrop={(e) => onDropOnStrip(e, col)}
          onClick={() => setActiveColumn(col)}
        >
          <For each={tabsIn(col)}>
            {(tab) => (
              <div
                class="terminal-tab"
                classList={{
                  active: tab.id === activeIdIn(col),
                  exited: tab.exited !== undefined,
                  renaming: tab.id === renamingId(),
                  dragging: draggingId() === tab.id,
                  'drop-before':
                    dropTarget().id === tab.id && draggingId() !== null && draggingId() !== tab.id,
                }}
                draggable={tab.id !== renamingId()}
                onDragStart={(e) => onDragStart(e, tab.id)}
                onDragEnd={onDragEndTab}
                onDragOver={(e) => onDragOverTab(e, tab.id, col)}
                onDrop={(e) => onDropOnTab(e, tab.id, col)}
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveIn(col, tab.id);
                  setActiveColumn(col);
                }}
                onDblClick={(e) => {
                  if ((e.target as HTMLElement).closest('.terminal-tab-close')) return;
                  setRenamingId(tab.id);
                }}
                title={
                  tab.cwd
                    ? `${displayName(tab)} — ${tab.cwd}`
                    : displayName(tab) === tab.label
                      ? tab.label
                      : `${tab.label} (renamed)`
                }
              >
                <Show
                  when={tab.id === renamingId()}
                  fallback={<span class="terminal-tab-label">{displayName(tab)}</span>}
                >
                  <input
                    class="terminal-tab-rename"
                    type="text"
                    value={displayName(tab)}
                    ref={(el) => queueMicrotask(() => el && (el.focus(), el.select()))}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => commitRename(tab.id, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitRename(tab.id, e.currentTarget.value);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setRenamingId(null);
                      }
                      e.stopPropagation();
                    }}
                  />
                </Show>
                <button
                  class="terminal-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}
          </For>
          <button
            class="terminal-tab-add"
            onClick={(e) => {
              e.stopPropagation();
              nextSpawnColumn = col;
              setActiveColumn(col);
              void spawnUserShell(null, 'my');
            }}
            title="New shell tab (cwd: conception)"
          >
            +
          </button>
          <Show when={props.launcherCommand?.trim()}>
            <button
              class="terminal-tab-add launcher"
              onClick={(e) => {
                e.stopPropagation();
                nextSpawnColumn = col;
                setActiveColumn(col);
                void spawnUserShell(props.launcherCommand, 'my');
              }}
              title={`New ${props.launcherCommand} tab (cwd: conception)`}
              aria-label={`New ${props.launcherCommand} tab`}
            >
              λ
            </button>
          </Show>
          <span class="terminal-tab-strip-spacer" />
          <button
            class="terminal-tab-add"
            onClick={(e) => {
              e.stopPropagation();
              setActiveColumn(col);
              saveActiveBuffer();
            }}
            title="Save the active terminal buffer to a file"
            aria-label="Save buffer"
          >
            ⤓
          </button>
          <button
            class="terminal-tab-add"
            onClick={(e) => {
              e.stopPropagation();
              setActiveColumn(col);
              setSearchOpen(true);
              queueMicrotask(() => searchInputRef?.focus());
            }}
            title="Find in buffer (Ctrl+F)"
            aria-label="Find"
          >
            ⌕
          </button>
        </div>
        <div
          class="terminal-host"
          ref={(el) => {
            if (col === 'left') leftHost = el;
            else rightHost = el;
          }}
        />
      </div>
    );
  };

  let columnsRoot: HTMLDivElement | undefined;

  return (
    <section
      class="terminal-pane"
      classList={{ closed: !props.open }}
      style={{ height: `${paneHeight()}px` }}
    >
      <div
        class="terminal-pane-resize"
        onMouseDown={(e) => startHeightDrag(e)}
        title="Drag to resize"
      />
      <button
        class="terminal-pane-close"
        onClick={props.onClose}
        title="Close pane"
        aria-label="Close pane"
      >
        ×
      </button>
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
            onMouseDown={(e) => columnsRoot && startSplitterDrag(e, columnsRoot)}
            title="Drag to resize columns"
          />
          {renderColumn('right')}
        </Show>
        {/* When unsplit and a tab is being dragged, expose a thin drop zone on
            the right edge — dropping there promotes the layout to split. */}
        <Show when={!isSplit() && draggingId() !== null}>
          <div
            class="terminal-split-dropzone"
            classList={{
              hover: dropTarget().column === 'right',
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropTarget({ id: null, column: 'right' });
            }}
            onDragLeave={() => {
              if (dropTarget().column === 'right' && dropTarget().id === null) {
                setDropTarget({ id: null, column: null });
              }
            }}
            onDrop={(e) => onDropOnStrip(e, 'right')}
          >
            <span>Drop to split →</span>
          </div>
        </Show>
      </div>
      <Show when={searchOpen()}>
        <div class="terminal-search-bar">
          <input
            ref={(el) => (searchInputRef = el)}
            class="terminal-search-input"
            type="text"
            placeholder="Find in buffer…"
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(e.shiftKey ? 'prev' : 'next');
              }
              e.stopPropagation();
            }}
          />
          <button
            class="terminal-search-action"
            onClick={() => runSearch('prev')}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            ↑
          </button>
          <button
            class="terminal-search-action"
            onClick={() => runSearch('next')}
            title="Next match (Enter)"
            aria-label="Next match"
          >
            ↓
          </button>
          <button
            class="terminal-search-action"
            onClick={closeSearch}
            title="Close (Esc)"
            aria-label="Close find"
          >
            ×
          </button>
        </div>
      </Show>
    </section>
  );
}

// Re-export for callers that destructure both surface types together.
export type { TerminalPrefs };
