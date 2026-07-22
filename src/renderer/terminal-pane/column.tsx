import { createSignal, For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Agent, TermDeath } from '@shared/types';
import { isAbnormalDeath } from '@shared/term-death-shape';
import { RefreshIcon } from '../icons';
import { createDropdownMenu } from '../dropdown-menu';
import { SpawnDropdown } from './column-parts/spawn-dropdown';
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

/** Very short verdict text for the tab strip, where horizontal room is scarce.
 *  The full sentence lives in the tooltip. */
function shortDeathLabel(death: TermDeath): string {
  switch (death.kind) {
    case 'oom-cap':
    case 'oom-pressure':
      return 'OOM';
    case 'killed':
      return 'killed';
    case 'signal':
      return death.signal !== undefined ? `sig ${death.signal}` : 'signal';
    case 'failed':
      return `exit ${death.exitCode ?? '?'}`;
    // A `stopped` row only survives long enough to render when the OOM killer
    // fired during the stop — an ordinary stop auto-closes. That is the one
    // thing worth showing about it.
    case 'stopped':
      return 'OOM';
    default:
      return '';
  }
}

/** Native-tooltip text spelling out the verdict and the evidence behind it —
 *  the difference between "hit its own cap" and "killed by the system under
 *  pressure" is the distinction the whole feature exists to draw, so it is
 *  stated in words rather than left to the reader. */
function deathTitle(death: TermDeath): string {
  const parts = [death.label];
  if (death.kind === 'oom-cap') {
    parts.push('This tab exceeded its own memory cap and its cgroup OOM killer stopped it.');
  } else if (death.kind === 'oom-pressure') {
    parts.push(
      'The system killed this tab under memory pressure while it was being throttled — ' +
        'it did not reach its own cap.',
    );
  }
  if (death.exitCode !== undefined) parts.push(`Exit code ${death.exitCode}.`);
  return parts.join(' ');
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
  /** Repaint a specific tab (active-tab in-title button + Refresh context-menu
   *  item); promotes it to active first so there is a live terminal to redraw.
   *  Nudges the pty size so the program redraws — clears a half-frame left by
   *  the hidden-tab serialize/hydrate round-trip. */
  onRefreshTab: (id: string) => void;
  /** Relaunch an abnormally-exited tab in place — same cwd, command, and column.
   *  Only reachable from a dead tab's row, which is kept on screen precisely so
   *  this is possible. */
  onRestartTab: (id: string) => void;
  /** True when the bottom band is showing the Dashboard rather than the
   *  terminals. Drives the active state of the Dashboard pseudo-tab (and
   *  suppresses the active ring on the real terminal tabs). */
  dashboardActive: boolean;
  /** Select the Dashboard body. The Dashboard pseudo-tab (always first in the
   *  left column's strip) fires this; re-selecting it closes the pane. */
  onToggleDashboard: () => void;
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
      <div class="terminal-header">
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
                {/* Death verdict — the whole reason an abnormally-exited row is
                 *  kept on screen. Without it a killed tab was indistinguishable
                 *  from one the user closed. */}
                <Show when={tab.death && isAbnormalDeath(tab.death)}>
                  <span
                    class="terminal-tab-death"
                    classList={{ oom: tab.death!.kind.startsWith('oom-') }}
                    title={deathTitle(tab.death!)}
                  >
                    {shortDeathLabel(tab.death!)}
                  </span>
                </Show>
                <Show when={tab.death && isAbnormalDeath(tab.death)}>
                  <button
                    type="button"
                    class="terminal-tab-restart"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onRestartTab(tab.id);
                    }}
                    onDblClick={(e) => e.stopPropagation()}
                    title="Relaunch this session (same command and directory)"
                    aria-label="Restart terminal"
                  >
                    Restart
                  </button>
                </Show>
                {/* Repaint affordance — only on the selected tab, trailing the
                 *  title (right edge). Replaces the old column-level Refresh
                 *  toolbar button; stops propagation so it neither re-activates
                 *  the tab nor starts a rename on double-click. */}
                <Show
                  when={
                    tab.id === props.activeId &&
                    tab.exited === undefined &&
                    !props.dashboardActive &&
                    tab.id !== props.renamingId
                  }
                >
                  <button
                    type="button"
                    class="terminal-tab-refresh"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onRefreshTab(tab.id);
                    }}
                    onDblClick={(e) => e.stopPropagation()}
                    title="Repaint this terminal (fixes a stale buffer after tab-switch)"
                    aria-label="Refresh terminal"
                  >
                    <RefreshIcon />
                  </button>
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
          <SpawnDropdown
            agents={props.agents}
            onSpawn={(id) => props.onSpawnShell(props.col, id)}
          />
        </div>
        <div class="terminal-header-actions">
          <button
            type="button"
            class="terminal-header-action"
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
            type="button"
            class="terminal-header-action"
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
        </div>
      </div>
      <div class="terminal-host" ref={(el) => props.registerHost(props.col, el)} />
      {/* Right-click tab menu. Portal'd to the body so it isn't clipped by the
       *  header bounds (same reason as the spawn dropdown). */}
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
