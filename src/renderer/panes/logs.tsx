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
import type { LogsOpenRequest, TaskRunGroup, TermLogSessionMeta } from '@shared/types';
import { ConfirmModal } from '../confirm-modal';
import { LogsViewerModal } from '../logs-modal';
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
  // days). Day strings sort lexicographically === chronologically, so a plain
  // string compare against the cutoff partitions the list. Computed once at
  // mount — fine for a pane whose lifetime is a session.
  const today = localDayStr();
  const recentCutoff = daysAgoStr(6);

  /** Last 7 days that have logs, newest-first (preserves `logsListDays` order). */
  const recentDays = createMemo<KnownDay[]>(() =>
    (days() ?? []).filter((d) => d.day >= recentCutoff),
  );

  // Eager-load only the recent band (≤7 days) so it renders instantly; older
  // months stay lazy until their group is expanded (see the month onToggle).
  // The requestedDays guard makes this idempotent across days() refetches.
  createEffect(() => loadDays(recentDays().map((d) => d.day)));

  /** Older days, grouped by `YYYY-MM`, months newest-first; days within a
   *  month keep the newest-first order from `logsListDays`. */
  const monthGroups = createMemo<{ key: string; days: KnownDay[] }[]>(() => {
    const map = new Map<string, KnownDay[]>();
    for (const d of (days() ?? []).filter((day) => day.day < recentCutoff)) {
      const key = d.day.slice(0, 7);
      const bucket = map.get(key);
      if (bucket) bucket.push(d);
      else map.set(key, [d]);
    }
    return [...map.keys()]
      .sort((a, b) => (a < b ? 1 : -1))
      .map((key) => ({ key, days: map.get(key)! }));
  });

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

/** One task's run group in the "Task runs" view — a collapsible header with a
 *  trigger badge and a row per run, opening the same viewer as a session. */
function TaskRunGroupView(props: {
  group: TaskRunGroup;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}): JSX.Element {
  return (
    <details class="logs-day-group" open>
      <summary class="logs-day-header">
        <span class="logs-caret" aria-hidden="true" />
        <span class="logs-day-label">{props.group.taskSlug}</span>
        <span class="logs-taskrun-trigger" data-trigger={props.group.trigger}>
          {props.group.trigger}
        </span>
        <span class="logs-group-count">{props.group.runs.length}</span>
      </summary>
      <ul class="logs-day-sessions">
        <For each={props.group.runs}>
          {(run) => (
            <li class="logs-session-li">
              <button
                type="button"
                class="logs-session-card"
                onClick={() => props.onOpen(run.path)}
              >
                <span class="logs-session-time">
                  {run.day} {run.time}
                </span>
                <span class="logs-session-cmd">{run.sid}</span>
                <span class="logs-session-size">{formatBytes(run.bytes)}</span>
              </button>
              <button
                type="button"
                class="logs-session-reveal"
                title="Reveal in file manager"
                aria-label="Reveal in file manager"
                onClick={() => props.onReveal(run.path)}
              >
                ⤷
              </button>
            </li>
          )}
        </For>
      </ul>
    </details>
  );
}

/** One known log day as returned by `logsListDays` (newest-first). */
type KnownDay = { day: string; path: string; sessions: number };

/** Local-date `YYYY-MM-DD` for a `Date` (defaults to now). Local, not UTC, so
 *  "today" matches the day strings the writer stamps from local time. */
function localDayStr(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` of the day `n` days before now (local). */
function daysAgoStr(n: number): string {
  const now = new Date();
  return localDayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
}

/** "Mon 24 May" label for a `YYYY-MM-DD` day string. */
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** "May 2026" label for a `YYYY-MM` month key. */
function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** The session-card grid for one day, or an empty-state line. */
function DaySessionGrid(props: {
  sessions: TermLogSessionMeta[];
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}): JSX.Element {
  return (
    <Show
      when={props.sessions.length > 0}
      fallback={<div class="logs-day-empty">No sessions.</div>}
    >
      <ul class="logs-day-sessions">
        <For each={props.sessions}>
          {(sess) => (
            <SessionCard
              sess={sess}
              onOpen={() => props.onOpen(sess.path)}
              onReveal={props.onReveal}
            />
          )}
        </For>
      </ul>
    </Show>
  );
}

function SessionCard(props: {
  sess: TermLogSessionMeta;
  onOpen: () => void;
  onReveal: (path: string) => void;
}): JSX.Element {
  const isFailure = (): boolean =>
    typeof props.sess.exitCode === 'number' && props.sess.exitCode !== 0;
  // `exitCode === undefined` → no footer on disk → session genuinely alive.
  // `exitCode === null`      → footer was synthesised by the boot-time
  //                            orphan-seal sweep, real exit unknown but
  //                            the session is definitely *not* running.
  const isRunning = (): boolean => props.sess.exitCode === undefined;
  const isSealed = (): boolean => props.sess.exitSealed === true;
  const statusLabel = (): string => {
    if (isRunning()) return 'running';
    if (isSealed()) return 'ended ?';
    return `exit ${props.sess.exitCode}`;
  };
  const statusTitle = (): string | undefined => {
    if (!isSealed()) return undefined;
    return 'Session ended without a recorded exit code (condash exited or crashed before the footer could flush).';
  };
  return (
    <li class="logs-session-li">
      <button
        type="button"
        class="logs-session-card"
        classList={{ running: isRunning(), failed: isFailure(), sealed: isSealed() }}
        onClick={props.onOpen}
      >
        <span class="logs-session-time">{props.sess.time}</span>
        <Show when={props.sess.repo}>
          <span class="logs-session-repo">{props.sess.repo}</span>
        </Show>
        <span class="logs-session-cmd">{props.sess.cmd ?? '(no command)'}</span>
        <span class="logs-session-size">{formatBytes(props.sess.bytes)}</span>
        <span class="logs-session-exit" title={statusTitle()}>
          {statusLabel()}
        </span>
      </button>
      <button
        type="button"
        class="logs-session-reveal"
        title="Reveal in file manager"
        aria-label="Reveal in file manager"
        onClick={() => props.onReveal(props.sess.path)}
      >
        ⤷
      </button>
    </li>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
