import { createEffect, createResource, createSignal, For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import { AnsiUp } from 'ansi_up';
import type { TermLogSessionMeta, TermLogSessionRead } from '@shared/types';
import { ConfirmModal } from '../confirm-modal';
import { expandCursorForward } from './logs-render';
import './logs-pane.css';

/**
 * Logs pane — browse `<conception>/.condash/logs/`.
 *
 * Layout:
 *   - Row 1: Day select · Session select · Refresh · Delete session.
 *   - Row 2: Search box (substring match against the rendered session text).
 *   - Body: header line with cmd / exit / repo, then the rendered
 *     terminal buffer styled via `ansi_up` (ANSI SGR → HTML spans with
 *     inline colour). Cursor-forward (`CSI N C`) is pre-expanded to N
 *     spaces — `@xterm/addon-serialize` uses CUF to encode empty cells,
 *     and ansi_up would otherwise drop it — see `logs-render.ts`. Other
 *     non-SGR escapes (mode set, cursor up/down/back) are dropped by
 *     ansi_up, which is correct for a static text rendering.
 *
 * The writer (`src/main/terminal-logger.ts`) feeds raw pty bytes into a
 * headless xterm and atomically writes the serialised buffer to a `.txt`
 * file every 5 s. We just read the file and let ansi_up draw it; no
 * replay pipeline on this side.
 */
export function LogsView(): JSX.Element {
  const [days, { refetch: refetchDays }] = createResource(() => window.condash.logsListDays());

  const [selectedDay, setSelectedDay] = createSignal<string | null>(null);
  const effectiveDay = createMemo(() => {
    const sel = selectedDay();
    if (sel) return sel;
    const list = days();
    return list && list.length > 0 ? list[0].day : null;
  });

  const [sessions, { refetch: refetchSessions }] = createResource(
    () => effectiveDay(),
    (day): Promise<TermLogSessionMeta[]> => {
      if (!day) return Promise.resolve([]);
      return window.condash.logsListSessions(day);
    },
  );

  const [selectedSession, setSelectedSession] = createSignal<TermLogSessionMeta | null>(null);

  // Auto-select the first session on day change so the search box +
  // delete button don't sit disabled.
  createEffect(() => {
    const list = sessions();
    if (!list) return;
    const current = selectedSession();
    if (current && list.some((s) => s.path === current.path)) return;
    setSelectedSession(list.length > 0 ? list[0] : null);
  });

  const [sessionRead, { refetch: refetchSessionRead }] = createResource(
    () => selectedSession(),
    (sess): Promise<TermLogSessionRead> => {
      if (!sess) return Promise.resolve({ text: '', meta: null });
      return window.condash.logsReadSession(sess.path);
    },
  );

  const [query, setQuery] = createSignal('');

  const ansiHtml = createMemo<string>(() => {
    const read = sessionRead();
    if (!read || !read.text) return '';
    const ansi = new AnsiUp();
    ansi.use_classes = false;
    return ansi.ansi_to_html(expandCursorForward(read.text));
  });

  const matches = createMemo<boolean>(() => {
    const read = sessionRead();
    if (!read || !read.text) return false;
    const q = query().trim().toLowerCase();
    if (q.length === 0) return true;
    return read.text.toLowerCase().includes(q);
  });

  const [pendingDelete, setPendingDelete] = createSignal<TermLogSessionMeta | null>(null);

  const refreshAll = (): void => {
    void refetchDays();
    void refetchSessions();
    void refetchSessionRead();
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
              <SessionHeader sess={sess()} />
              <Show when={!sessionRead.loading} fallback={<div class="empty">Loading…</div>}>
                <Show
                  when={(sessionRead()?.text.length ?? 0) > 0}
                  fallback={<div class="empty">Empty session.</div>}
                >
                  <Show
                    when={matches()}
                    fallback={<div class="empty">No matches for "{query()}".</div>}
                  >
                    <pre class="logs-transcript" innerHTML={ansiHtml()} />
                  </Show>
                </Show>
              </Show>
            </>
          )}
        </Show>
      </section>
    </div>
  );
}

function SessionHeader(props: { sess: TermLogSessionMeta }): JSX.Element {
  return (
    <div class="logs-events-head">
      <span class="logs-events-head-path">{props.sess.path}</span>
      <Show when={props.sess.cmd}>
        <span class="logs-events-head-cmd"> · {props.sess.cmd}</span>
      </Show>
      <Show when={props.sess.exitCode !== undefined}>
        <span class="logs-events-head-exit"> · exit {props.sess.exitCode}</span>
      </Show>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
