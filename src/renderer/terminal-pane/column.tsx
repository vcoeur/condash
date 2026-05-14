import { createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { LauncherConfig } from '@shared/types';
import { createDropdownMenu } from '../dropdown-menu';
import type { DragDropController } from './drag-drop';
import { type Column, displayName, type Tab } from './types';

export interface TerminalColumnProps {
  col: Column;
  tabs: Tab[];
  activeId: string | null;
  isActiveColumn: boolean;
  renamingId: string | null;
  /** Configured launcher slots. One menu item per entry whose `command` is
   *  non-empty, in the order they appear in `terminal.launchers`. */
  launchers: readonly LauncherConfig[];
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
  onSpawnShell: (col: Column, launcherIndex: number | null) => void;
  onSaveBuffer: (col: Column) => void;
  onOpenSearch: (col: Column) => void;
  /** Toggle the pane open/closed. The Terminal handle in the strip
   *  fires this. Only the left column renders the handle, so the pane
   *  has exactly one toggle regardless of split state. */
  onTogglePane: () => void;
}

/** Dropdown button + menu for spawning tabs. Replaces the fixed `+` / μ / λ
 *  button row with a single control that lists all configured launchers.
 *
 *  The menu is rendered with `position: fixed` (the `.portal` class via
 *  `createDropdownMenu`) so it escapes the strip's `overflow: auto` —
 *  otherwise the menu's full height gets clipped down to the strip's 32px
 *  box and the user sees only fragments of the menu items.
 */
function SpawnDropdown(props: {
  launchers: readonly LauncherConfig[];
  onSpawn: (index: number | null) => void;
}) {
  const menu = createDropdownMenu({ align: 'left' });
  const [highlighted, setHighlighted] = createSignal(0);

  const items = () => [
    { label: 'New shell', value: null as number | null },
    ...props.launchers
      .filter((l) => l.command.trim().length > 0)
      .map((l, i) => ({
        label: l.label || l.title || l.command,
        value: i,
      })),
  ];

  const select = (value: number | null) => {
    props.onSpawn(value);
    menu.close();
    setHighlighted(0);
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
    const count = items().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      select(items()[highlighted()].value);
    }
    // Escape is handled by createDropdownMenu globally.
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
            <For each={items()}>
              {(item, idx) => (
                <li
                  role="option"
                  aria-selected={highlighted() === idx()}
                  classList={{ highlighted: highlighted() === idx() }}
                  onMouseEnter={() => setHighlighted(idx())}
                  onClick={(e) => {
                    e.stopPropagation();
                    select(item.value);
                  }}
                >
                  {item.label}
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
              class="terminal-tab"
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
              onDblClick={(e) => {
                if ((e.target as HTMLElement).closest('.terminal-tab-close')) return;
                props.onRequestRename(tab.id);
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
              <button
                class="terminal-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onCloseTab(tab.id);
                }}
                title="Close tab"
              >
                ×
              </button>
            </div>
          )}
        </For>
        <SpawnDropdown
          launchers={props.launchers}
          onSpawn={(index) => props.onSpawnShell(props.col, index)}
        />
        <span class="terminal-tab-strip-spacer" />
        <button
          class="terminal-tab-add"
          onClick={(e) => {
            e.stopPropagation();
            props.onSaveBuffer(props.col);
          }}
          title="Save the active terminal buffer to a file"
          aria-label="Save buffer"
        >
          🖫
        </button>
        <button
          class="terminal-tab-add"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpenSearch(props.col);
          }}
          title="Find in buffer (Ctrl+F)"
          aria-label="Find"
        >
          {/* U+1F50D + U+FE0E forces the text-style monochrome glyph, so
           *  the lens matches the floppy's weight instead of the colour
           *  emoji default. */}
          🔍︎
        </button>
      </div>
      <div class="terminal-host" ref={(el) => props.registerHost(props.col, el)} />
    </div>
  );
}
