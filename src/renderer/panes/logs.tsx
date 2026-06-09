import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  Show,
  type Accessor,
  type JSX,
} from 'solid-js';
import { createStore } from 'solid-js/store';
import type { LogsOpenRequest, TermLogSessionMeta } from '@shared/types';
import { ConfirmModal } from '../confirm-modal';
import { LogsViewerModal } from '../logs-modal';
import {
  dayLabel,
  daysAgoStr,
  localDayStr,
  monthGroupsOf,
  monthLabel,
  recentDaysOf,
  type KnownDay,
} from './logs-parts/data';
import { DaySessionGrid } from './logs-parts/day-session-grid';
import { TaskRunGroupView } from './logs-parts/task-run-group';
import './logs-pane.css';

/** Which list the Logs pane shows: the normal day-grouped sessions, or the
 *  segregated task-run store under `.condash/{scheduled,manual}/` (caps 1+4). */
type LogsViewMode = 'sessions' | 'taskruns';

/**
 * Logs pane — browse `<conception>/.condash/logs/`.
 *
 * Shape: a single scrollable list of saved sessions grouped by day,
 * newest day first. Each session is a card showing time · repo · cmd ·
 * exit · size. Clicking a card opens the LogsViewerModal — a full-
 * overlay reader that handles the virtualised transcript + search.
 *
 * No day-picker / session-picker chrome (those have been folded into
 * the inline list). No inline transcript view (the modal owns it).
 *
 * Storage since v2.27.0: one plain-text `.txt` per session with a
 * `# condash: {...}` header line carrying spawn metadata and (after
 * exit) a footer line carrying `{finished, exitCode}`. The IPC layer
 * parses both back out — see `TermLogSessionMeta`.
 *
 * Global-search bridge: `openRequest` fires when the user activates a
 * log hit in the search modal. The pane responds by opening the viewer
 * modal directly on that session.
 *
 * Sub-components + the pure date/partition helpers live in `logs-parts/`
 * (invariant 12); this file keeps LogsView and the orchestration.
 */
export function LogsView(props: {
  openRequest?: Accessor<LogsOpenRequest | null>;
  /** Bumped by View → Refresh. Refetches days + sessions when it changes
   *  (deferred, so the initial createResource fetch isn't doubled). */
  refreshSignal?: Accessor<number>;
}): JSX.Element {
  const [days, { refetch: refetchDays }] = createResource(() => window.condash.logsListDays());

  // Per-day session metadata, populated lazily. The recent band loads on mount;
  // older months load only when their group is first expanded — so opening the
  // Logs pane no longer head/tail-reads every archived session. Day/month counts
  // and the headline total come from `days()` (cheap, always present), so a
  // collapsed group still shows its true count without its list being loaded.
  const [sessionsByDay, setSessionsByDay] = createStore<Record<string, TermLogSessionMeta[]>>({});
  const requestedDays = new Set<string>();

  const loadDay = async (day: string): Promise<void> => {
    if (requestedDays.has(day)) return;
    requestedDays.add(day);
    setSessionsByDay(day, await window.condash.logsListSessions(day));
  };
  const loadDays = (dayList: string[]): void => {
    for (const day of dayList) void loadDay(day);
  };

  const [activePath, setActivePath] = createSignal<string | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<TermLogSessionMeta | null>(null);

  // "Task runs" view — the segregated `.condash/{scheduled,manual}/` store.
  const [view, setView] = createSignal<LogsViewMode>('sessions');
  const [taskRuns, { refetch: refetchTaskRuns }] = createResource(() =>
    window.condash.logsListTaskRuns(),
  );

  // External "open this log" requests from the global-search modal.
  createEffect(() => {
    const req = props.openRequest?.();
    if (!req) return;
    setActivePath(req.path);
  });

  const refreshAll = (): void => {
    // Re-fetch exactly the days already loaded (recent band + any expanded
    // months); clearing the guard first forces loadDay to re-run and overwrite
    // in place. Kicked off before refetchDays so the recent-band effect below
    // sees them already requested and doesn't double-fetch.
    const previously = [...requestedDays];
    requestedDays.clear();
    loadDays(previously);
    void refetchDays();
    void refetchTaskRuns();
  };

  // External refresh from View → Refresh. `defer: true` skips the run on mount
  // so we don't refetch on top of the createResource initial load.
  createEffect(
    on(
      () => props.refreshSignal?.(),
      () => refreshAll(),
      { defer: true },
    ),
  );

  const confirmDeleteSession = (sess: TermLogSessionMeta): void => {
    void window.condash.logsDeleteSession(sess.path).then(() => {
      setPendingDelete(null);
      if (activePath() === sess.path) setActivePath(null);
      refreshAll();
    });
  };

  // From the day metadata (always present), not the lazily-loaded lists — so
  // the headline total is correct even before older months are expanded.
  const totalSessionCount = createMemo<number>(() =>
    (days() ?? []).reduce((n, d) => n + d.sessions, 0),
  );

  const taskRunCount = createMemo<number>(() =>
    (taskRuns() ?? []).reduce((n, g) => n + g.runs.length, 0),
  );

  // Today + the start of the 7-day "recent" window (today and the 6 prior
  // days). Computed once at mount — fine for a pane whose lifetime is a
  // session. The partition itself is the pure logs-parts/data helpers.
  const today = localDayStr();
  const recentCutoff = daysAgoStr(6);

  /** Last 7 days that have logs, newest-first (preserves `logsListDays` order). */
  const recentDays = createMemo<KnownDay[]>(() => recentDaysOf(days() ?? [], recentCutoff));

  // Eager-load only the recent band (≤7 days) so it renders instantly; older
  // months stay lazy until their group is expanded (see the month onToggle).
  // The requestedDays guard makes this idempotent across days() refetches.
  createEffect(() => loadDays(recentDays().map((d) => d.day)));

  /** Older days, grouped by `YYYY-MM`, months newest-first; days within a
   *  month keep the newest-first order from `logsListDays`. */
  const monthGroups = createMemo(() => monthGroupsOf(days() ?? [], recentCutoff));

  const sessionsFor = (day: string): TermLogSessionMeta[] => sessionsByDay[day] ?? [];

  const reveal = (path: string): void => void window.condash.showInFolder(path);

  return (
    <div class="logs-pane">
      <div class="logs-toolbar">
        <div class="logs-toolbar-row">
          <span class="logs-toolbar-title">Logs</span>
          <div class="seg seg--sm" role="tablist" aria-label="Logs view">
            <button
              type="button"
              role="tab"
              class="seg-item"
              classList={{ 'seg-item--active': view() === 'sessions' }}
              aria-selected={view() === 'sessions'}
              onClick={() => setView('sessions')}
            >
              Sessions
            </button>
            <button
              type="button"
              role="tab"
              class="seg-item"
              classList={{ 'seg-item--active': view() === 'taskruns' }}
              aria-selected={view() === 'taskruns'}
              onClick={() => setView('taskruns')}
            >
              Task runs
            </button>
          </div>
          <span class="logs-toolbar-count">
            <Show
              when={view() === 'sessions'}
              fallback={`${taskRunCount()} run${taskRunCount() === 1 ? '' : 's'}`}
            >
              {totalSessionCount()} session{totalSessionCount() === 1 ? '' : 's'}
            </Show>
          </span>
          <span class="logs-toolbar-spacer" />
          <button type="button" class="logs-refresh" onClick={refreshAll}>
            Refresh
          </button>
        </div>
      </div>

      <Show when={pendingDelete()}>
        {(sess) => (
          <ConfirmModal
            title="Delete session log"
            body={`Delete ${sess().day} ${sess().time}${sess().cmd ? ` — ${sess().cmd}` : ''}? This cannot be undone.`}
            confirmLabel="Delete"
            destructive
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => confirmDeleteSession(sess())}
          />
        )}
      </Show>

      <Show when={activePath()}>
        {(path) => (
          <LogsViewerModal
            path={path()}
            onClose={() => setActivePath(null)}
            onDelete={(sess) => {
              setActivePath(null);
              setPendingDelete(sess);
            }}
          />
        )}
      </Show>

      <Show when={view() === 'taskruns'}>
        <section class="logs-list logs-taskruns">
          <Show when={!taskRuns.loading} fallback={<div class="empty">Loading…</div>}>
            <Show
              when={(taskRuns() ?? []).length > 0}
              fallback={
                <div class="empty">
                  No task runs yet. Scheduled runs and manual runs flagged “Keep out of logs” land
                  here, kept separate from the normal session logs.
                </div>
              }
            >
              <For each={taskRuns()}>
                {(group) => (
                  <TaskRunGroupView group={group} onOpen={setActivePath} onReveal={reveal} />
                )}
              </For>
            </Show>
          </Show>
        </section>
      </Show>

      <Show when={view() === 'sessions'}>
        <section class="logs-list">
          <Show when={!days.loading} fallback={<div class="empty">Loading…</div>}>
            <Show
              when={(days() ?? []).length > 0}
              fallback={<div class="empty">No sessions captured yet.</div>}
            >
              {/* Recent band: one group per day for the last 7 days. Today is
                always expanded and non-collapsible; the other days are
                collapsible and default to collapsed. */}
              <For each={recentDays()}>
                {(d) => (
                  <Show
                    when={d.day !== today}
                    fallback={
                      <div class="logs-day-group logs-day-today">
                        <div class="logs-day-header logs-day-header-static">
                          <span class="logs-day-label">Today · {dayLabel(d.day)}</span>
                          <span class="logs-group-count">{d.sessions}</span>
                        </div>
                        <DaySessionGrid
                          sessions={sessionsFor(d.day)}
                          onOpen={setActivePath}
                          onReveal={reveal}
                        />
                      </div>
                    }
                  >
                    <details class="logs-day-group">
                      <summary class="logs-day-header">
                        <span class="logs-caret" aria-hidden="true" />
                        <span class="logs-day-label">{dayLabel(d.day)}</span>
                        <span class="logs-group-count">{d.sessions}</span>
                      </summary>
                      <DaySessionGrid
                        sessions={sessionsFor(d.day)}
                        onOpen={setActivePath}
                        onReveal={reveal}
                      />
                    </details>
                  </Show>
                )}
              </For>

              {/* Older band: collapsible per-month groups, default collapsed,
                with a light day sub-header inside each month. */}
              <For each={monthGroups()}>
                {(month) => (
                  <details
                    class="logs-month-group"
                    onToggle={(e) => {
                      if (e.currentTarget.open) loadDays(month.days.map((d) => d.day));
                    }}
                  >
                    <summary class="logs-month-header">
                      <span class="logs-caret" aria-hidden="true" />
                      <span class="logs-month-label">{monthLabel(month.key)}</span>
                      <span class="logs-group-count">
                        {month.days.reduce((n, d) => n + d.sessions, 0)}
                      </span>
                    </summary>
                    <For each={month.days}>
                      {(d) => (
                        <div class="logs-day-subgroup">
                          <div class="logs-day-subheader">{dayLabel(d.day)}</div>
                          <DaySessionGrid
                            sessions={sessionsFor(d.day)}
                            onOpen={setActivePath}
                            onReveal={reveal}
                          />
                        </div>
                      )}
                    </For>
                  </details>
                )}
              </For>
            </Show>
          </Show>
        </section>
      </Show>
    </div>
  );
}
