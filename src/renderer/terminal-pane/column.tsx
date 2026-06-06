import { createEffect, createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Agent } from '@shared/types';
import { createDropdownMenu } from '../dropdown-menu';
import type { DragDropController } from './drag-drop';
import { type Column, displayName, type Tab } from './types';

export interface TerminalColumnProps {
  col: Column;
  tabs: Tab[];
  activeId: string | null;
  isActiveColumn: boolean;
  renamingId: string | null;
  /** Configured agents (the `agents` settings list). One menu item each, in
   *  config order, alongside the "New shell" option. */
  agents: readonly Agent[];
  /** True when the surrounding pane is currently visible. Drives the
   *  active state of the in-strip Terminal handle. */
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
  /** Toggle the pane open/closed. The Terminal handle in the strip
   *  fires this. Only the left column renders the handle, so the pane
   *  has exactly one toggle regardless of split state. */
  onTogglePane: () => void;
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
 */
function SpawnDropdown(props: {
  agents: readonly Agent[];
  onSpawn: (agentId: string | null) => void;
}) {
  const menu = createDropdownMenu({ align: 'left' });
  const [highlighted, setHighlighted] = createSignal(0);
  const [submenuOpen, setSubmenuOpen] = createSignal(false);
  const [subHighlighted, setSubHighlighted] = createSignal(0);

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
        {/* Terminal handle — only in the left column so the pane has
         *  one toggle regardless of split state. Doubles as both
         *  open-pane and hide-pane (active when open). */}
        <Show when={props.col === 'left'}>
          <button
            class="terminal-pane-handle"
            classList={{ active: props.paneOpen }}
            aria-pressed={props.paneOpen}
            onClick={(e) => {
              e.stopPropagation();
              props.onTogglePane();
            }}
            title={props.paneOpen ? 'Hide Terminal' : 'Show Terminal'}
          >
            Terminal
          </button>
        </Show>
        <For each={props.tabs}>
          {(tab) => (
            <div
              class={`terminal-tab app-pill-${tab.colorSlot ?? 0}`}
              classList={{
                active: tab.id === props.activeId,
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
              // Always lead with the complete current title so a hover reveals
              // the full text when the label is truncated; append the cwd as
              // context when the shell reported one.
              title={tab.cwd ? `${displayName(tab)} — ${tab.cwd}` : displayName(tab)}
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
            </div>
          )}
        </For>
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
