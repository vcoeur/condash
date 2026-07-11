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
//
// The controller logic (signals, session reconciliation, xterm lifecycle, IPC
// wiring, and the imperative handle) lives in `terminal-pane/controller.ts`;
// this file keeps only the JSX shell + wiring.

import { Show } from 'solid-js';
import type {
  Agent,
  TaskRunContext,
  TermSide,
  TermSpawnRequest,
  TerminalXtermPrefs,
} from '@shared/types';
import { TerminalColumn } from './terminal-pane/column';
import { DRAG_MIME } from './terminal-pane/drag-drop';
import { type Column } from './terminal-pane/types';
import { createTerminalController } from './terminal-pane/controller';
import { DashboardView } from './panes/dashboard';
import './panes/app-pill.css';
import './terminal-pane.css';

export interface SpawnOptions {
  /** Lock the tab title to `label` so OSC 7 cwd updates from the shell
   *  don't override it. Default false (current "+" new-shell behavior). */
  pinned?: boolean;
}

/** Spawn-time agent selector. Passing an `Agent` pins the tab label to the
 *  agent's label and runs its `command`; passing `null` is the plain `+`
 *  behaviour (default shell, unpinned label tracking OSC 7 cwd). */
export type AgentChoice = Agent | null;

export interface TerminalPaneHandle {
  spawn(request: TermSpawnRequest, label: string, opts?: SpawnOptions): Promise<string>;
  switchTo(side: TermSide, id?: string): void;
  /** Add a fresh user shell tab to "My terms". `agent` may be an `Agent` to pin
   *  and run that agent's command, or `null` for a plain shell. `titleOverride`
   *  pins a custom tab label (e.g. a task's `<agent>•<title>`) instead of the
   *  agent's own label. `taskContext` routes the session's log to the
   *  segregated `.condash/<trigger>/<slug>/` store (capability 4). */
  spawnUserShell(
    agent?: AgentChoice,
    side?: TermSide,
    titleOverride?: string,
    taskContext?: TaskRunContext,
  ): Promise<string>;
  /** Move the active tab within its column strip. */
  moveActiveTab(direction: -1 | 1): void;
  /** Type a literal string into the active terminal (no shell parsing). */
  typeIntoActive(text: string): void;
  /** True when there is an active session in the active column. */
  hasActive(): boolean;
  /** Return the active session ID for the active column, or null. */
  getActiveSessionId(): string | null;
}

export interface TerminalPaneProps {
  open: boolean;
  onClose: () => void;
  /** Which body the bottom band shows when open: the terminals or the
   *  Dashboard. The Dashboard pseudo-tab toggles to 'dashboard'; activating any
   *  real terminal tab returns to 'terminal'. */
  bottomView: 'terminal' | 'dashboard';
  /** Toggle a bottom-band view from the strip. The parent decides the
   *  open/close semantics (re-selecting the active band closes the pane); this
   *  just reports the intent. The Dashboard pseudo-tab fires it with
   *  'dashboard'. */
  onSelectBand: (view: 'terminal' | 'dashboard') => void;
  /** Show the terminal body without the toggle-to-close semantics — fired when
   *  a real terminal tab is activated, so picking a tab always lands on its
   *  terminal (opening the pane if needed) and never closes it. */
  onShowTerminalBand: () => void;
  registerHandle: (handle: TerminalPaneHandle | null) => void;
  /** Configured agents (the `agents` settings list). Each renders as an option
   *  in the tab-strip spawn dropdown (alongside "New shell"). */
  agents: readonly Agent[];
  /** Working directory passed to spawned user shells (typically the
   * conception path). */
  cwd?: string | null;
  /** User-configured xterm preferences (font, colours, scrollback, …). Pulled
   *  from settings.json under `terminal.xterm`. Undefined = defaults. */
  xtermPrefs?: TerminalXtermPrefs;
  /** When not explicitly false, switching to a tab auto-runs the Refresh
   *  (repaint) action on the newly-active tab. Pulled from
   *  `terminal.autoRefreshOnTabSwitch`. */
  autoRefreshOnTabSwitch?: boolean;
}

export function TerminalPane(props: TerminalPaneProps) {
  const {
    tabsIn,
    activeIdIn,
    activeColumn,
    renamingId,
    setActiveColumn,
    setActiveIn,
    setRenamingId,
    commitRename,
    closeTab,
    spawnUserShell,
    resolveAgent,
    saveActiveBuffer,
    refreshColumn,
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
    splitToggle,
  } = createTerminalController(props);

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
      registerHost={registerHost}
      onActivateColumn={setActiveColumn}
      onActivateTab={(c, id) => {
        setActiveIn(c, id);
        setActiveColumn(c);
        // Selecting a terminal tab always lands on the terminal body (and opens
        // the pane if it was closed) — picking a tab should never leave the
        // Dashboard up or close the pane.
        props.onShowTerminalBand();
      }}
      onRequestRename={setRenamingId}
      onCommitRename={commitRename}
      onCancelRename={() => setRenamingId(null)}
      onCloseTab={closeTab}
      onSpawnShell={(c, agentId) => {
        setNextSpawnColumn(c);
        setActiveColumn(c);
        void spawnUserShell(resolveAgent(agentId), 'my');
      }}
      onSaveBuffer={(c) => {
        setActiveColumn(c);
        saveActiveBuffer();
      }}
      onOpenSearch={(c) => {
        setActiveColumn(c);
        search.openSearch();
      }}
      onRefresh={(c) => {
        setActiveColumn(c);
        refreshColumn(c);
      }}
      onRefreshTab={(id) => refreshSession(id)}
      dashboardActive={props.bottomView === 'dashboard'}
      onToggleDashboard={() => props.onSelectBand('dashboard')}
      onSplitToggle={splitToggle}
      isSplit={isSplit()}
      cwd={props.cwd}
    />
  );

  let columnsRoot: HTMLDivElement | undefined;

  return (
    <section
      class="terminal-pane"
      classList={{
        closed: !props.open,
        'dashboard-active': props.open && props.bottomView === 'dashboard',
      }}
      style={{ height: `${paneHeight()}px` }}
      ref={registerPaneSection}
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
      {/* Dashboard body — shown in place of the terminal columns when the
          Dashboard handle is active. The columns stay mounted (CSS hides the
          xterm hosts) so terminals are never disposed; the strip with both
          handles remains visible above. */}
      <Show when={props.open && props.bottomView === 'dashboard'}>
        <div class="terminal-dashboard-band">
          <DashboardView />
        </div>
      </Show>
      {search.SearchBar()}
    </section>
  );
}
