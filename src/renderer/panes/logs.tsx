import { createEffect, createResource, createSignal, For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { TermLogEvent, TermLogSessionMeta } from '@shared/types';
import { ConfirmModal } from '../confirm-modal';
import './logs-pane.css';

/**
 * Logs pane — browse `<conception>/.condash/logs/`.
 *
 * Layout:
 *   - Row 1: Day select · Session select · Refresh · Delete session.
 *   - Row 2: Search box (substring match against canonicalised event text).
 *   - Body: events for the selected session, plain monospace text, ANSI
 *     stripped on render.
 *
 * Scope kept tight: no cross-day search, no virtual list, no embedded
 * xterm replay. The viewer is plain monospace text — ANSI is stripped on
 * render so unprintable escape sequences don't break the layout.
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

  // Auto-select the first session whenever the session list arrives or
  // changes. Without this, the search input + delete-session button stay
  // disabled and the events panel reads "Pick a session" on every day
  // change — and the new design has no session rail for the user to
  // click on.
  createEffect(() => {
    const list = sessions();
    if (!list) return;
    const current = selectedSession();
    if (current && list.some((s) => s.path === current.path)) return;
    setSelectedSession(list.length > 0 ? list[0] : null);
  });

  // Events for the selected session file.
  const [events, { refetch: refetchEvents }] = createResource(
    () => selectedSession(),
    (sess): Promise<TermLogEvent[]> => {
      if (!sess) return Promise.resolve([]);
      // Cap at 5000 lines to keep the renderer responsive on huge logs.
      return window.condash.logsReadEvents(sess.path, 0, 5000);
    },
  );

  // Free-text search box. Substring match (case-insensitive) against
  // `ev.text` (canonicalised by the IPC reader) with `stripAnsi(data)`
  // fallback for older events that lack `text`.
  const [query, setQuery] = createSignal('');

  const filteredEvents = createMemo<TermLogEvent[]>(() => {
    const all = events() ?? [];
    const q = query().trim().toLowerCase();
    if (q.length === 0) return all;
    return all.filter((ev) => searchableBody(ev).toLowerCase().includes(q));
  });

  const [pendingDelete, setPendingDelete] = createSignal<TermLogSessionMeta | null>(null);

  const refreshAll = (): void => {
    void refetchDays();
    void refetchSessions();
    void refetchEvents();
  };

  const confirmDeleteSession = (sess: TermLogSessionMeta): void => {
    void window.condash.logsDeleteSession(sess.path).then(() => {
      setPendingDelete(null);
      setSelectedSession(null);
      refreshAll();
    });
  };

  return (
    <div class="logs-pane">
      <div class="logs-toolbar">
        <div class="logs-toolbar-row">
          <label class="logs-picker">
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
          <label class="logs-picker logs-picker--session">
            <span>Session</span>
            <select
              value={selectedSession()?.path ?? ''}
              onChange={(e) => {
                const path = e.currentTarget.value;
                const match = (sessions() ?? []).find((s) => s.path === path) ?? null;
                setSelectedSession(match);
              }}
              disabled={(sessions()?.length ?? 0) === 0}
            >
              <For each={sessions() ?? []}>
                {(meta) => <option value={meta.path}>{sessionLabel(meta)}</option>}
              </For>
              <Show when={(sessions()?.length ?? 0) === 0}>
                <option value="">no sessions</option>
              </Show>
            </select>
          </label>
          <span class="logs-toolbar-spacer" />
          <button type="button" class="logs-refresh" onClick={refreshAll}>
            Refresh
          </button>
          <button
            type="button"
            class="logs-delete-day"
            disabled={!selectedSession()}
            onClick={() => {
              const s = selectedSession();
              if (s) setPendingDelete(s);
            }}
          >
            Delete session
          </button>
        </div>
        <div class="logs-toolbar-row logs-toolbar-row--search">
          <input
            type="search"
            class="logs-search"
            placeholder="Search this session…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            disabled={!selectedSession()}
          />
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

      <section class="logs-events">
        <Show when={selectedSession()} fallback={<div class="empty">Pick a session above.</div>}>
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
                  <Show
                    when={filteredEvents().length > 0}
                    fallback={
                      <div class="empty">
                        No matches for "{query()}" ({events()?.length ?? 0} events).
                      </div>
                    }
                  >
                    <For each={filteredEvents()}>{(ev) => <EventRow ev={ev} />}</For>
                  </Show>
                </Show>
              </div>
            </>
          )}
        </Show>
      </section>
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

function sessionLabel(meta: TermLogSessionMeta): string {
  const head = meta.repo ? `${meta.time} · ${meta.repo}` : meta.time;
  const cmd = meta.cmd ? ` · ${truncate(meta.cmd, 60)}` : '';
  const size = ` · ${formatBytes(meta.bytes)}`;
  const exit = meta.exitCode !== undefined ? ` · exit ${meta.exitCode}` : '';
  return `${head}${cmd}${size}${exit}`;
}

function eventBody(ev: TermLogEvent): string {
  if (ev.kind === 'spawn') {
    const argv = Array.isArray(ev.argv) ? ev.argv.join(' ') : '';
    return `${ev.cmd ?? ''} ${argv}`.trim();
  }
  if (ev.kind === 'in' || ev.kind === 'out') {
    // Prefer the IPC-side canonicalisation (handles backspaces / Ctrl+U
    // for `in`, drops bare \r for `out`). Fall back to stripAnsi(data)
    // for resilience — only matters if a future change forgets to
    // populate `text` for some kind.
    return ev.text ?? stripAnsi(ev.data ?? '');
  }
  if (ev.kind === 'exit') {
    return `exitCode=${ev.exitCode ?? '?'}`;
  }
  if (ev.kind === 'rotate') {
    return `rotated from ${ev.from ?? ''} to ${ev.to ?? ''}`;
  }
  return '';
}

/** Searchable form of an event — same canonical text the row renders. */
function searchableBody(ev: TermLogEvent): string {
  return eventBody(ev);
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
