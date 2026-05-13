import { createResource, createSignal, For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { TermLogEvent, TermLogSessionMeta } from '@shared/types';
import { ConfirmModal } from '../confirm-modal';
import './logs-pane.css';

/**
 * Logs pane — browse `<conception>/.condash/logs/`.
 *
 * Layout:
 *   - Top toolbar: day picker.
 *   - Left rail: one row per session-file for the chosen day.
 *   - Right panel: events from the selected session, plain-text with
 *     a `[kind]` chip per line.
 *
 * Scope kept tight on first ship: no search, no virtual list, no
 * embedded xterm replay. The viewer is plain monospace text — ANSI is
 * stripped on render so unprintable escape sequences don't break the
 * layout. Filtering / search / xterm-readable mode land as follow-ups.
 */
export function LogsView(): JSX.Element {
  // The list of available day-dirs (newest first).
  const [days, { refetch: refetchDays }] = createResource(() => window.condash.logsListDays());

  // Currently-selected day; defaults to the newest available.
  const [selectedDay, setSelectedDay] = createSignal<string | null>(null);
  const effectiveDay = createMemo(() => {
    const sel = selectedDay();
    if (sel) return sel;
    const list = days();
    return list && list.length > 0 ? list[0].day : null;
  });

  // Sessions for the active day.
  const [sessions, { refetch: refetchSessions }] = createResource(
    () => effectiveDay(),
    (day): Promise<TermLogSessionMeta[]> => {
      if (!day) return Promise.resolve([]);
      return window.condash.logsListSessions(day);
    },
  );

  const [selectedSession, setSelectedSession] = createSignal<TermLogSessionMeta | null>(null);

  // Events for the selected session file.
  const [events, { refetch: refetchEvents }] = createResource(
    () => selectedSession(),
    (sess): Promise<TermLogEvent[]> => {
      if (!sess) return Promise.resolve([]);
      // Cap at 5000 lines to keep the renderer responsive on huge logs.
      return window.condash.logsReadEvents(sess.path, 0, 5000);
    },
  );

  const [pendingDelete, setPendingDelete] = createSignal<string | null>(null);

  const refreshAll = (): void => {
    void refetchDays();
    void refetchSessions();
    void refetchEvents();
  };

  const confirmDelete = (day: string): void => {
    void window.condash.logsDeleteDay(day).then(() => {
      setPendingDelete(null);
      setSelectedSession(null);
      refreshAll();
    });
  };

  return (
    <div class="logs-pane">
      <div class="logs-toolbar">
        <label class="logs-day-picker">
          <span>Day</span>
          <select
            value={effectiveDay() ?? ''}
            onChange={(e) => {
              setSelectedDay(e.currentTarget.value || null);
              setSelectedSession(null);
            }}
            disabled={(days()?.length ?? 0) === 0}
          >
            <For each={days() ?? []}>
              {(entry) => <option value={entry.day}>{entry.day}</option>}
            </For>
            <Show when={(days()?.length ?? 0) === 0}>
              <option value="">no logs</option>
            </Show>
          </select>
        </label>
        <button type="button" class="logs-refresh" onClick={refreshAll}>
          Refresh
        </button>
        <Show when={effectiveDay()}>
          {(day) => (
            <button type="button" class="logs-delete-day" onClick={() => setPendingDelete(day())}>
              Delete day
            </button>
          )}
        </Show>
      </div>

      <Show when={pendingDelete()}>
        {(day) => (
          <ConfirmModal
            title="Delete day's logs"
            body={`Delete every log file from ${day()}? This cannot be undone.`}
            confirmLabel="Delete"
            destructive
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => confirmDelete(day())}
          />
        )}
      </Show>

      <div class="logs-body">
        <aside class="logs-sessions">
          <Show
            when={(sessions()?.length ?? 0) > 0}
            fallback={<div class="empty">No sessions for {effectiveDay() ?? '—'}.</div>}
          >
            <For each={sessions() ?? []}>
              {(meta) => (
                <button
                  type="button"
                  class="logs-session-row"
                  classList={{
                    'logs-session-row--selected': selectedSession()?.path === meta.path,
                    'logs-session-row--exited': meta.exitCode !== undefined,
                  }}
                  onClick={() => setSelectedSession(meta)}
                >
                  <div class="logs-session-time">{meta.time}</div>
                  <div class="logs-session-meta">
                    <Show when={meta.repo}>
                      <span class="logs-session-repo">{meta.repo}</span>
                    </Show>
                    <Show when={meta.cmd}>
                      {(cmd) => <span class="logs-session-cmd">{truncate(cmd(), 80)}</span>}
                    </Show>
                  </div>
                  <div class="logs-session-size">
                    {formatBytes(meta.bytes)}
                    <Show when={meta.exitCode !== undefined}>
                      <span class="logs-session-exit">· exit {meta.exitCode}</span>
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </aside>

        <section class="logs-events">
          <Show
            when={selectedSession()}
            fallback={<div class="empty">Pick a session on the left.</div>}
          >
            {(sess) => (
              <>
                <div class="logs-events-head">
                  <span>{sess().path}</span>
                </div>
                <div class="logs-events-list">
                  <Show
                    when={(events()?.length ?? 0) > 0}
                    fallback={<div class="empty">Empty session.</div>}
                  >
                    <For each={events() ?? []}>{(ev) => <EventRow ev={ev} />}</For>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </section>
      </div>
    </div>
  );
}

function EventRow(props: { ev: TermLogEvent }): JSX.Element {
  const { ev } = props;
  return (
    <div class={`logs-event logs-event--${ev.kind}`}>
      <span class="logs-event-ts">{ev.ts.slice(11, 23)}</span>
      <span class="logs-event-kind">{ev.kind}</span>
      <span class="logs-event-body">{eventBody(ev)}</span>
    </div>
  );
}

function eventBody(ev: TermLogEvent): string {
  if (ev.kind === 'spawn') {
    const argv = Array.isArray(ev.argv) ? ev.argv.join(' ') : '';
    return `${ev.cmd ?? ''} ${argv}`.trim();
  }
  if (ev.kind === 'in' || ev.kind === 'out') {
    return stripAnsi(ev.data ?? '');
  }
  if (ev.kind === 'exit') {
    return `exitCode=${ev.exitCode ?? '?'}`;
  }
  if (ev.kind === 'rotate') {
    return `rotated from ${ev.from ?? ''} to ${ev.to ?? ''}`;
  }
  return '';
}

// Lightweight stripper that matches the writer's policy — keep this in
// sync with `stripAnsi` in main/terminal-logger.ts.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
