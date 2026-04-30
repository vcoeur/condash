import { type Accessor, createSignal, type Setter } from 'solid-js';
import { setMeta } from './persistence';
import type { Column, Tab } from './types';

/** dataTransfer MIME for cross-column tab drag — keep it specific so
 *  external drops (file URLs, etc.) don't get mistaken for tab drops. */
export const DRAG_MIME = 'application/x-condash-term-tab';

export interface DropTarget {
  id: string | null;
  column: Column | null;
}

export interface DragDropDeps {
  /** Live tabs accessor (used to find the source tab on move). */
  tabs: Accessor<Tab[]>;
  setTabs: Setter<Tab[]>;
  /** Move an existing xterm element to a new column's host (called after a
   *  successful column-change drop so the xterm canvas follows the tab). */
  moveMount: (id: string, newColumn: Column) => void;
  /** Set the active tab in `col`. */
  setActiveIn: (col: Column, id: string | null) => void;
  setActiveColumn: (col: Column) => void;
  /** Re-fit + focus the active xterm after a layout change. */
  focusActive: () => void;
}

export interface DragDropController {
  /** Currently-dragging tab id, or null. */
  draggingId: Accessor<string | null>;
  /** Current drop target (tab id or column-only). */
  dropTarget: Accessor<DropTarget>;
  setDropTarget: Setter<DropTarget>;
  clearDragState: () => void;
  onDragStart: (e: DragEvent, id: string) => void;
  onDragEndTab: () => void;
  onDragOverTab: (e: DragEvent, targetId: string, targetColumn: Column) => void;
  onDragOverStrip: (e: DragEvent, column: Column) => void;
  onDragLeaveStrip: (e: DragEvent, column: Column) => void;
  onDropOnTab: (e: DragEvent, targetId: string, targetColumn: Column) => void;
  onDropOnStrip: (e: DragEvent, column: Column) => void;
}

/** Cross-column drag-and-drop controller for the terminal pane's tab
 *  strips. Owns the `draggingId` / `dropTarget` signals and the move
 *  pipeline (reorder within a column, or change column + re-parent the
 *  xterm element). */
export function createDragDropController(deps: DragDropDeps): DragDropController {
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<DropTarget>({ id: null, column: null });

  const clearDragState = () => {
    setDraggingId(null);
    setDropTarget({ id: null, column: null });
  };

  /** Move tab `srcId`. If `beforeId` set, insert before that tab; else
   *  append to the end of `column`'s strip. Updates xterm host parent if
   *  the column changed. */
  const moveTab = (srcId: string, target: { beforeId?: string; column: Column }) => {
    deps.setTabs((prev) => {
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
    // Wait for the right column to mount if it didn't exist before (split
    // just got promoted by this drop) — host elements register on render.
    queueMicrotask(() => {
      deps.moveMount(srcId, target.column);
      const tab = deps.tabs().find((t) => t.id === srcId);
      if (tab) {
        setMeta(srcId, { label: tab.label, customName: tab.customName, column: target.column });
      }
      deps.setActiveIn(target.column, srcId);
      deps.setActiveColumn(target.column);
      queueMicrotask(deps.focusActive);
    });
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

  return {
    draggingId,
    dropTarget,
    setDropTarget,
    clearDragState,
    onDragStart,
    onDragEndTab,
    onDragOverTab,
    onDragOverStrip,
    onDragLeaveStrip,
    onDropOnTab,
    onDropOnStrip,
  };
}
