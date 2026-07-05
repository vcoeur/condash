import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Agent } from '@shared/types';
import { createDropdownMenu } from '../dropdown-menu';
import type { DragDropController } from './drag-drop';
import { type Column, displayName, type Tab } from './types';

/** Compact memory label for the per-tab meter. Tab scopes are GB-scale, so this
 *  stays short ("6.2G"), dropping to MB only below ~100 MB. */
function formatMem(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 0.1) return `${gb.toFixed(1)}G`;
  return `${Math.round(bytes / 1024 ** 2)}M`;
}

/** True once a scoped tab is within 80% of its hard cap — the early-warning
 *  band before the cgroup OOM kills it. */
function memWarn(tab: Tab): boolean {
  return (
    tab.memBytes !== undefined &&
    tab.memMaxBytes !== undefined &&
    tab.memBytes / tab.memMaxBytes >= 0.8
  );
}

/** Native-tooltip text for the tab meter. */
function memTitle(tab: Tab): string {
  if (tab.memBytes === undefined) return '';
  const used = formatMem(tab.memBytes);
  if (tab.memMaxBytes === undefined) return `Memory: ${used}`;
  return (
    `Memory: ${used} of ${formatMem(tab.memMaxBytes)} cap` +
    (memWarn(tab) ? ' — approaching cap; this tab will be killed at the cap' : '')
  );
}

export interface TerminalColumnProps {
  col: Column;
  tabs: Tab[];
  activeId: string | null;
  isActiveColumn: boolean;
  renamingId: string | null;
  /** Configured agents (the `agents` settings list). One menu item each, in
   *  config order, alongside the "New shell" option. */
  agents: readonly Agent[];
  /** True when the surrounding pane is currently visible. Together with
   *  `dashboardActive` it drives the active state of the in-strip Dashboard
   *  pseudo-tab. */
  paneOpen: boolean;
  dnd: DragDropController;
  /** Refs for the xterm host (one per column; the parent stashes them so
   *  it can re-parent xterm elements on column moves). */
  registerHost: (col: Column, el: HTMLDivElement) => void;
  onActivateColumn: (col: Column) => void;
  onActivateTab: (col: Column, id: string) => void;
  onRequestRename: (id: string) => void;
  onCommitRename: (id: string, value: string) => void;
  onCancelRename: () => void;
  onCloseTab: (id: string) => void;
  onSpawnShell: (col: Column, agentId: string | null) => void;
  onSaveBuffer: (col: Column) => void;
  onOpenSearch: (col: Column) => void;
  /** Repaint the column's active tab (Refresh strip button). Nudges the pty
   *  size so the running program redraws — clears a half-frame left by the
   *  hidden-tab serialize/hydrate round-trip. */
  onRefresh: (col: Column) => void;
  /** Repaint a specific tab (Refresh context-menu item); promotes it to active
   *  first so there is a live terminal to redraw. */
  onRefreshTab: (id: string) => void;
  /** True when the bottom band is showing the Dashboard rather than the
   *  terminals. Drives the active state of the Dashboard pseudo-tab (and
   *  suppresses the active ring on the real terminal tabs). */
  dashboardActive: boolean;
  /** Select the Dashboard body. The Dashboard pseudo-tab (always first in the
   *  left column's strip) fires this; re-selecting it closes the pane. */
  onToggleDashboard: () => void;
}

/** One row of the primary spawn menu: the plain shell, a launchable agent, or
 *  the `More ▸` toggle that owns the overflow submenu. */
interface SpawnRow {
  label: string;
  /** Agent id to launch, or null for the plain shell. Unused for the More row. */
  value: string | null;
  /** Marks the `More ▸` toggle row (opens the overflow submenu, never spawns). */
  isMore?: boolean;
  /** Render a leading ★ — only when the favourites split is active. */
  isFavorite?: boolean;
}

/** Dropdown button + menu for spawning tabs. Replaces the fixed `+` / μ / λ
 *  button row with a single control that lists configured launchers.
 *
 *  When at least one agent is marked `favorite`, the menu lists `New shell` +
 *  the favourites (starred) directly and tucks the rest behind a `More ▸`
 *  fly-out submenu. With no favourites it lists every agent inline (the
 *  pre-favourites behaviour).
 *
 *  The menu is rendered with `position: fixed` (the `.portal` class via
 *  `createDropdownMenu`) so it escapes the strip's `overflow: auto` —
 *  otherwise the menu's full height gets clipped down to the strip's 32px
 *  box and the user sees only fragments of the menu items. The submenu is a
 *  nested `<ul>` *inside* that portal'd menu (not a second portal) so a click
 *  on it counts as inside `menuEl` and createDropdownMenu's outside-click
 *  dismissal leaves it open.
 *
 *  The overflow submenu stays `position: absolute` relative to the `More ▸`
 *  row, opening to its right by default (so a hover-open never drops an item
 *  under the cursor). `positionSubmenu` below picks a CSS `column-count` so a
 *  long agent list wraps into side-by-side columns that fit the viewport band
 *  (with a scroll fallback), and flips the fly-out left or up only when the
 *  default placement would spill past a viewport edge.
 */
function SpawnDropdown(props: {
  agents: readonly Agent[];
  onSpawn: (agentId: string | null) => void;
}) {
  const menu = createDropdownMenu({ align: 'left' });
  const [highlighted, setHighlighted] = createSignal(0);
  const [submenuOpen, setSubmenuOpen] = createSignal(false);
  const [subHighlighted, setSubHighlighted] = createSignal(0);
  // The `More ▸` row and its fly-out, for viewport-aware placement.
  let moreRowEl: HTMLLIElement | undefined;
  let submenuEl: HTMLUListElement | undefined;

  const favorites = () => props.agents.filter((a) => a.favorite);
  const others = () => props.agents.filter((a) => !a.favorite);
  // No favourite designated → list every agent inline, no split (back-compat).
  const usesFavorites = () => favorites().length > 0;
  const primaryAgents = () => (usesFavorites() ? favorites() : props.agents);
  const hasMore = () => usesFavorites() && others().length > 0;

  const rows = (): SpawnRow[] => {
    const list: SpawnRow[] = [{ label: 'New shell', value: null }];
    for (const agent of primaryAgents()) {
      list.push({ label: agent.label, value: agent.id, isFavorite: usesFavorites() });
    }
    if (hasMore()) list.push({ label: 'More', value: null, isMore: true });
    return list;
  };

  // Reset transient menu state whenever the menu closes (select, outside click,
  // or the global Escape handler in createDropdownMenu) so a re-open starts at
  // the top with the submenu collapsed.
  createEffect(() => {
    if (!menu.isOpen()) {
      setSubmenuOpen(false);
      setHighlighted(0);
      setSubHighlighted(0);
    }
  });

  // Keep the overflow fly-out fully inside the viewport. The submenu is
  // `position: absolute` relative to the `More ▸` row, so its inline top/left
  // are offsets *from that row*. First we choose a `column-count` so a long
  // list wraps into side-by-side columns that each fit the viewport band; then
  // we cap max-height/-width and measure the default right-opening placement,
  // flipping only when it would spill past an edge (clearing the inline offset
  // to fall back to the CSS defaults when it already fits).
  const positionSubmenu = () => {
    const submenu = submenuEl;
    const moreRow = moreRowEl;
    if (!submenu || !moreRow) return;
    const margin = 8;
    const gap = 2;
    const availableHeight = window.innerHeight - margin * 2;
    // Reset to one column + no caps to measure the natural single-column list.
    submenu.style.columnCount = '';
    submenu.style.maxHeight = '';
    submenu.style.left = '';
    submenu.style.top = '';
    const itemCount = submenu.childElementCount;
    const naturalHeight = submenu.scrollHeight;
    // Wrap into as many columns as it takes to keep each within the band. CSS
    // multicol then balances the rows and sizes the box to fit every column.
    if (itemCount > 0 && naturalHeight > availableHeight) {
      const rowHeight = naturalHeight / itemCount;
      const perColumn = Math.max(1, Math.floor(availableHeight / rowHeight));
      submenu.style.columnCount = `${Math.ceil(itemCount / perColumn)}`;
    }
    submenu.style.maxHeight = `${availableHeight}px`;
    submenu.style.maxWidth = `${window.innerWidth - margin * 2}px`;
    // Reading back forces a synchronous layout reflecting the caps + columns.
    const moreRect = moreRow.getBoundingClientRect();
    let submenuRect = submenu.getBoundingClientRect();
    // Horizontal: keep opening right if it fits; else flip to the left of the
    // row; else (wider than either side) pin to the left viewport margin.
    if (submenuRect.right > window.innerWidth - margin) {
      if (moreRect.left - gap - submenuRect.width >= margin) {
        submenu.style.left = `${-(submenuRect.width + gap)}px`;
      } else {
        submenu.style.left = `${margin - moreRect.left}px`;
      }
      submenuRect = submenu.getBoundingClientRect();
    }
    // Vertical: flip up when the bottom would cross the viewport. The capped
    // height guarantees the flipped top still clears the top margin.
    if (submenuRect.bottom > window.innerHeight - margin) {
      const desiredTop = Math.max(margin, window.innerHeight - margin - submenuRect.height);
      submenu.style.top = `${desiredTop - moreRect.top}px`;
    }
  };

  // Re-place the fly-out whenever it opens, after the browser has laid out the
  // freshly-rendered <li> list (hence rAF).
  createEffect(() => {
    if (submenuOpen()) requestAnimationFrame(positionSubmenu);
  });

  // Keep it pinned to its row if the window resizes or the strip scrolls while
  // open (mirrors createDropdownMenu's primary-menu reflow).
  onMount(() => {
    const reflow = () => {
      if (submenuOpen()) positionSubmenu();
    };
    window.addEventListener('resize', reflow, true);
    window.addEventListener('scroll', reflow, true);
    onCleanup(() => {
      window.removeEventListener('resize', reflow, true);
      window.removeEventListener('scroll', reflow, true);
    });
  });

  const openSubmenu = () => {
    setSubHighlighted(0);
    setSubmenuOpen(true);
  };

  const select = (value: string | null) => {
    props.onSpawn(value);
    menu.close();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!menu.isOpen()) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setHighlighted(0);
        menu.open();
      }
      return;
    }
    // Submenu has keyboard focus: cycle the overflow agents; ArrowLeft returns
    // to the primary menu. (Escape closes everything via createDropdownMenu.)
    if (submenuOpen()) {
      const subCount = others().length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSubHighlighted((h) => (h + 1) % subCount);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSubHighlighted((h) => (h - 1 + subCount) % subCount);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        select(others()[subHighlighted()].id);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Right is a no-op here; Left collapses back to the primary menu.
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setSubmenuOpen(false);
        }
      }
      return;
    }
    const list = rows();
    const count = list.length;
    const current = list[highlighted()];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + count) % count);
    } else if (e.key === 'ArrowRight' && current?.isMore) {
      e.preventDefault();
      openSubmenu();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current?.isMore) openSubmenu();
      else select(current?.value ?? null);
    }
  };

  return (
    <>
      <button
        ref={menu.setTrigger}
        class="terminal-tab-dropdown"
        aria-haspopup="listbox"
        aria-expanded={menu.isOpen()}
        aria-label="Spawn new terminal"
        onClick={(e) => {
          setHighlighted(0);
          menu.toggle(e);
        }}
        onKeyDown={handleKeyDown}
      >
        <span>New shell</span>
        <span aria-hidden="true">▼</span>
      </button>
      <Show when={menu.isOpen() && menu.anchor()}>
        {/* Portal to document.body so the menu escapes `.terminal-pane`'s
         *  `contain: layout paint` — that containment makes
         *  `position: fixed` anchor to the pane instead of the viewport,
         *  which would render the menu hundreds of pixels off. */}
        <Portal>
          <ul
            ref={menu.setMenu}
            class="terminal-tab-dropdown-menu portal"
            role="listbox"
            aria-label="Terminal spawn options"
            style={{
              top: `${menu.anchor()!.top}px`,
              left: `${menu.anchor()!.left}px`,
            }}
          >
            <For each={rows()}>
              {(row, idx) => (
                <li
                  ref={(el) => {
                    if (row.isMore) moreRowEl = el;
                  }}
                  role="option"
                  class={row.isMore ? 'terminal-tab-dropdown-more' : undefined}
                  aria-haspopup={row.isMore ? 'true' : undefined}
                  aria-expanded={row.isMore ? submenuOpen() : undefined}
                  aria-selected={highlighted() === idx()}
                  classList={{ highlighted: highlighted() === idx() }}
                  onMouseEnter={() => {
                    setHighlighted(idx());
                    if (row.isMore) openSubmenu();
                    else setSubmenuOpen(false);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (row.isMore) {
                      // Idempotent open — hover already opens it, so a click
                      // (hover + press) must not toggle it back shut. Collapse
                      // via leaving the row, Escape, or ArrowLeft.
                      setHighlighted(idx());
                      openSubmenu();
                    } else {
                      select(row.value);
                    }
                  }}
                >
                  <Show
                    when={row.isMore}
                    fallback={
                      <>
                        <Show when={row.isFavorite}>
                          <span class="terminal-tab-dropdown-star" aria-hidden="true">
                            ★
                          </span>
                        </Show>
                        {row.label}
                      </>
                    }
                  >
                    <span>{row.label}</span>
                    <span aria-hidden="true">▸</span>
                    <Show when={submenuOpen()}>
                      <ul
                        ref={(el) => (submenuEl = el)}
                        class="terminal-tab-dropdown-submenu"
                        role="listbox"
                        aria-label="More agents"
                      >
                        <For each={others()}>
                          {(agent, subIdx) => (
                            <li
                              role="option"
                              aria-selected={subHighlighted() === subIdx()}
                              classList={{ highlighted: subHighlighted() === subIdx() }}
                              onMouseEnter={() => setSubHighlighted(subIdx())}
                              onClick={(e) => {
                                e.stopPropagation();
                                select(agent.id);
                              }}
                            >
                              {agent.label}
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Portal>
      </Show>
    </>
  );
}

/** One column of the bottom terminal pane: tab strip on top + xterm host
 *  underneath. The xterm canvases themselves are appended to the host
 *  imperatively by the parent (so they can be re-parented across columns
 *  on drag-drop without losing their buffer). */
export function TerminalColumn(props: TerminalColumnProps) {
  // Right-click context menu (Close / Rename), anchored at the cursor. Tracks
  // which tab it was opened on so the action targets the right session.
  const ctxMenu = createDropdownMenu({ align: 'left' });
  const [ctxTabId, setCtxTabId] = createSignal<string | null>(null);

  // Hover popover showing the dashboard summary (current action + context) for
  // the tab under the cursor. Only the tabs that carry a dashboard summary
  // trigger it; the rest keep the plain native title tooltip.
  const [hovered, setHovered] = createSignal<Tab | null>(null);
  const [hoverAt, setHoverAt] = createSignal<{ top: number; left: number } | null>(null);
  const hasSummary = (tab: Tab): boolean =>
    Boolean(tab.currentAction || (tab.contextLines && tab.contextLines.length > 0));
  const openTabPopover = (tab: Tab, el: HTMLElement): void => {
    if (!hasSummary(tab)) return;
    const rect = el.getBoundingClientRect();
    setHovered(tab);
    setHoverAt({ top: rect.bottom + 4, left: rect.left });
  };

  return (
    <div class="terminal-column" classList={{ active: props.isActiveColumn }}>
      <div
        class="terminal-tabs"
        classList={{
          'drop-strip-target':
            props.dnd.draggingId() !== null &&
            props.dnd.dropTarget().column === props.col &&
            props.dnd.dropTarget().id === null,
        }}
        onDragOver={(e) => props.dnd.onDragOverStrip(e, props.col)}
        onDragLeave={(e) => props.dnd.onDragLeaveStrip(e, props.col)}
        onDrop={(e) => props.dnd.onDropOnStrip(e, props.col)}
        onClick={() => props.onActivateColumn(props.col)}
      >
        {/* Dashboard pseudo-tab — always present, always first, left column
         *  only (it is one global view, not a per-column body). It reads as a
         *  tab but is fixed: not draggable, renamable, or closable. Selecting
         *  it shows the Dashboard body; selecting any real terminal tab below
         *  switches back to the terminal view. Re-selecting it while active
         *  closes the pane (same affordance the old Dashboard handle had). */}
        <Show when={props.col === 'left'}>
          <button
            type="button"
            class="terminal-tab terminal-tab-dashboard"
            classList={{ active: props.paneOpen && props.dashboardActive }}
            aria-pressed={props.paneOpen && props.dashboardActive}
            title="Dashboard — live summary of all terminal tabs"
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleDashboard();
            }}
          >
            <span class="terminal-tab-dashboard-icon" aria-hidden="true">
              ▦
            </span>
            <span class="terminal-tab-label">Dashboard</span>
          </button>
        </Show>
        <For each={props.tabs}>
          {(tab) => (
            <div
              class={`terminal-tab app-pill-${tab.colorSlot ?? 0}`}
              data-sid={tab.id}
              classList={{
                active: tab.id === props.activeId && !props.dashboardActive,
                exited: tab.exited !== undefined,
                renaming: tab.id === props.renamingId,
                dragging: props.dnd.draggingId() === tab.id,
                'drop-before':
                  props.dnd.dropTarget().id === tab.id &&
                  props.dnd.draggingId() !== null &&
                  props.dnd.draggingId() !== tab.id,
              }}
              draggable={tab.id !== props.renamingId}
              onDragStart={(e) => props.dnd.onDragStart(e, tab.id)}
              onDragEnd={props.dnd.onDragEndTab}
              onDragOver={(e) => props.dnd.onDragOverTab(e, tab.id, props.col)}
              onDrop={(e) => props.dnd.onDropOnTab(e, tab.id, props.col)}
              onClick={(e) => {
                e.stopPropagation();
                props.onActivateTab(props.col, tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtxTabId(tab.id);
                ctxMenu.openAt(e.clientX, e.clientY);
              }}
              onDblClick={() => props.onRequestRename(tab.id)}
              onMouseEnter={(e) => openTabPopover(tab, e.currentTarget)}
              onMouseLeave={() => setHovered(null)}
              // When the dashboard has a summary for this tab, the rich hover
              // popover replaces the native tooltip (showing both would stack two
              // tooltips). Otherwise lead with the full title so a hover reveals
              // truncated text, and append the cwd when the shell reported one.
              title={
                hasSummary(tab)
                  ? undefined
                  : tab.cwd
                    ? `${displayName(tab)} — ${tab.cwd}`
                    : displayName(tab)
              }
            >
              <Show when={tab.busy && tab.exited === undefined && tab.id !== props.renamingId}>
                <span class="terminal-tab-busy" aria-hidden="true" />
              </Show>
              <Show
                when={tab.id === props.renamingId}
                fallback={<span class="terminal-tab-label">{displayName(tab)}</span>}
              >
                <input
                  class="terminal-tab-rename"
                  type="text"
                  value={displayName(tab)}
                  ref={(el) => queueMicrotask(() => el && (el.focus(), el.select()))}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => props.onCommitRename(tab.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      props.onCommitRename(tab.id, e.currentTarget.value);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      props.onCancelRename();
                    }
                    e.stopPropagation();
                  }}
                />
              </Show>
              <Show
                when={
                  tab.exited === undefined &&
                  tab.memBytes !== undefined &&
                  tab.id !== props.renamingId
                }
              >
                <span
                  class="terminal-tab-mem"
                  classList={{ warn: memWarn(tab) }}
                  title={memTitle(tab)}
                >
                  {formatMem(tab.memBytes!)}
                </span>
              </Show>
            </div>
          )}
        </For>
        <Show when={hovered()}>
          {(tab) => (
            <Portal>
              <div
                class="terminal-tab-popover portal"
                style={{ top: `${hoverAt()?.top ?? 0}px`, left: `${hoverAt()?.left ?? 0}px` }}
              >
                <div class="terminal-tab-popover-title">{displayName(tab())}</div>
                <Show when={tab().currentAction}>
                  <div class="terminal-tab-popover-action">{tab().currentAction}</div>
                </Show>
                <Show when={(tab().contextLines?.length ?? 0) > 0}>
                  <ul class="terminal-tab-popover-context">
                    <For each={tab().contextLines}>{(line) => <li>{line}</li>}</For>
                  </ul>
                </Show>
                <Show when={tab().cwd}>
                  <div class="terminal-tab-popover-cwd">{tab().cwd}</div>
                </Show>
              </div>
            </Portal>
          )}
        </Show>
        <SpawnDropdown agents={props.agents} onSpawn={(id) => props.onSpawnShell(props.col, id)} />
        <span class="terminal-tab-strip-spacer" />
        <button
          class="terminal-tab-add"
          data-label="save"
          onClick={(e) => {
            e.stopPropagation();
            props.onSaveBuffer(props.col);
          }}
          title="Save the active terminal buffer to a file"
          aria-label="Save buffer"
        >
          Save
        </button>
        <button
          class="terminal-tab-add"
          data-label="find"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpenSearch(props.col);
          }}
          title="Find in buffer (Ctrl+F)"
          aria-label="Find"
        >
          Find
        </button>
        <button
          class="terminal-tab-add"
          data-label="refresh"
          onClick={(e) => {
            e.stopPropagation();
            props.onRefresh(props.col);
          }}
          title="Repaint the active terminal (fixes a stale buffer after tab-switch)"
          aria-label="Refresh"
        >
          Refresh
        </button>
      </div>
      <div class="terminal-host" ref={(el) => props.registerHost(props.col, el)} />
      {/* Right-click tab menu. Portal'd to the body so it escapes the strip's
       *  `overflow: auto` (same reason as the spawn dropdown). */}
      <Show when={ctxMenu.isOpen() && ctxMenu.anchor()}>
        <Portal>
          <div
            ref={ctxMenu.setMenu}
            class="terminal-tab-context-menu portal"
            role="menu"
            style={{
              top: `${ctxMenu.anchor()!.top}px`,
              left: `${ctxMenu.anchor()!.left}px`,
            }}
          >
            <button
              class="terminal-tab-context-menu-item"
              role="menuitem"
              onClick={() => {
                const id = ctxTabId();
                ctxMenu.close();
                if (id) props.onRequestRename(id);
              }}
            >
              Rename
            </button>
            <button
              class="terminal-tab-context-menu-item"
              role="menuitem"
              onClick={() => {
                const id = ctxTabId();
                ctxMenu.close();
                if (id) props.onRefreshTab(id);
              }}
            >
              Refresh
            </button>
            <button
              class="terminal-tab-context-menu-item danger"
              role="menuitem"
              onClick={() => {
                const id = ctxTabId();
                ctxMenu.close();
                if (id) props.onCloseTab(id);
              }}
            >
              Close
            </button>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
