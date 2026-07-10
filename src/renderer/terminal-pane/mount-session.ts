// Standalone xterm mount helper for the terminal-pane controller.
//
// Pulled out so the cleanup-on-failure path (dynamic-import throw, race bail-out)
// can be unit-tested without spinning up the full Solid controller.

import type { Setter } from 'solid-js';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { TerminalXtermPrefs } from '@shared/types';
import type { MountedTerm } from '../xterm-mount';
import { shouldPromoteOnFocus } from './visibility-plan';
import type { Column, Tab } from './types';

export interface XtermHandle {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  mounted: MountedTerm;
  element: HTMLDivElement;
  column: Column;
  detachListeners?: () => void;
}

export interface MountSessionContext {
  xterms: Map<string, XtermHandle>;
  pendingMounts: Set<string>;
  hostFor: (column: Column) => HTMLDivElement | undefined;
  xtermPrefs?: TerminalXtermPrefs;
  handleXtermKey: (ev: KeyboardEvent, id: string) => boolean;
  setTabs: Setter<Tab[]>;
  activeIdIn: (col: Column) => string | null;
  activeColumn: () => Column;
  setActiveIn: (col: Column, id: string | null) => void;
  setActiveColumn: (col: Column) => void;
  transitioningInColumn: Record<Column, number>;
}

/** Mount an xterm element into the host of its column. xterm + its addons are
 *  dynamic-imported on first call so they stay out of the boot chunk; the
 *  module is cached after the first load.
 *
 *  On any failure path — including a thrown dynamic import or the post-import
 *  race bail-out — the re-entrancy guard is cleared and the created element is
 *  removed from the DOM. */
export async function mountForSession(
  ctx: MountSessionContext,
  id: string,
  column: Column,
  replay?: string,
): Promise<void> {
  if (ctx.xterms.has(id) || ctx.pendingMounts.has(id)) return;
  ctx.pendingMounts.add(id);
  const element = document.createElement('div');
  element.className = 'xterm-host';
  element.style.display = 'none';
  const host = ctx.hostFor(column);
  if (host) host.appendChild(element);
  try {
    const { mountXterm } = await import('../xterm-mount');
    // Bail if a dispose/race removed the need while the chunk was loading.
    if (ctx.xterms.has(id)) {
      element.remove();
      return;
    }
    const mounted = mountXterm(element, id, {
      replay,
      prefs: ctx.xtermPrefs,
      onCustomKey: (ev) => ctx.handleXtermKey(ev, id),
    });
    const handleEntry: XtermHandle = {
      term: mounted.term,
      fit: mounted.fit,
      search: mounted.search,
      serialize: mounted.serialize,
      mounted,
      element,
      column,
    };
    ctx.xterms.set(id, handleEntry);
    // Promote this tab to active when the user clicks/focuses inside the
    // xterm (otherwise typing into it works but the tab strip's "active"
    // styling stays on whichever tab last got a click).
    const promote = () => {
      // `ctx.xterms.get(id)?.column` so a tab that's been moved between columns
      // still resolves to its current side.
      const col = ctx.xterms.get(id)?.column ?? column;
      // Ignore focus churn during a visibility transition IN THIS COLUMN. A tab
      // switch demotes the old DOM Terminal and mounts the new one, and that
      // teardown/mount moves DOM focus programmatically — a `focusin` fires on
      // a terminal the user did NOT select. Honouring it here would call
      // `setActiveIn` for the wrong tab, reverting the in-flight switch and
      // demoting the tab the user actually picked (the hidden-tab round-trip
      // then reads no live Terminal). Gating on the column (not the global set)
      // keeps that guard while letting a genuine click in the OTHER column
      // through even when this one is mid-transition or stuck (R1). Genuine user
      // clicks/focus land in the steady state, when this column is idle.
      if (!shouldPromoteOnFocus(ctx.transitioningInColumn[col])) return;
      if (ctx.activeIdIn(col) !== id) ctx.setActiveIn(col, id);
      if (ctx.activeColumn() !== col) ctx.setActiveColumn(col);
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
      ctx.setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, cwd } : t)));
    });
    // Track the window title the program announces via OSC 0/2 (e.g. a harness
    // summary) → reflect in the tab label. Coalesced + glyph-stripped upstream.
    mounted.onTitleChange((termTitle) => {
      ctx.setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, termTitle } : t)));
    });
    // Track OSC 9;4 progress → drive the tab's busy/idle indicator.
    mounted.onProgressChange((busy) => {
      ctx.setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, busy } : t)));
    });
  } finally {
    // Always clear the re-entrancy guard and remove the element on any failure
    // path (including a thrown dynamic import or the post-import race bail-out).
    // On success `ctx.xterms.set` has run, so the element stays in the DOM.
    ctx.pendingMounts.delete(id);
    if (!ctx.xterms.has(id)) element.remove();
  }
}
