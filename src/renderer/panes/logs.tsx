import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  type Accessor,
  type JSX,
} from 'solid-js';
import type { LogsOpenRequest, TermLogSessionMeta } from '@shared/types';
import { ConfirmModal } from '../confirm-modal';
import { LogsViewerModal } from '../logs-modal';
import './logs-pane.css';

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
export function LogsView(props: { openRequest?: Accessor<LogsOpenRequest | null> }): JSX.Element {
  const [days, { refetch: refetchDays }] = createResource(() => window.condash.logsListDays());

  // For each known day, fetch its session list. Indexed by `day` string.
  const [sessionsByDay, { refetch: refetchSessions }] = createResource(
    () => days(),
    async (dayList): Promise<Map<string, TermLogSessionMeta[]>> => {
      const out = new Map<string, TermLogSessionMeta[]>();
      if (!dayList) return out;
      for (const d of dayList) {
        out.set(d.day, await window.condash.logsListSessions(d.day));
      }
      return out;
    },
  );

  const [activePath, setActivePath] = createSignal<string | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<TermLogSessionMeta | null>(null);

  // External "open this log" requests from the global-search modal.
  createEffect(() => {
    const req = props.openRequest?.();
    if (!req) return;
    setActivePath(req.path);
  });

  const refreshAll = (): void => {
    void refetchDays();
    void refetchSessions();
  };

  const confirmDeleteSession = (sess: TermLogSessionMeta): void => {
    void window.condash.logsDeleteSession(sess.path).then(() => {
      setPendingDelete(null);
      if (activePath() === sess.path) setActivePath(null);
      refreshAll();
    });
  };

  const totalSessionCount = createMemo<number>(() => {
    const map = sessionsByDay();
    if (!map) return 0;
    let n = 0;
    for (const arr of map.values()) n += arr.length;
    return n;
  });

  return (
    <div class="logs-pane">
      <div class="logs-toolbar">
        <div class="logs-toolbar-row">
          <span class="logs-toolbar-title">Logs</span>
          <span class="logs-toolbar-count">
            {totalSessionCount()} session{totalSessionCount() === 1 ? '' : 's'}
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

      <section class="logs-list">
        <Show
          when={!days.loading && !sessionsByDay.loading}
          fallback={<div class="empty">Loading…</div>}
        >
          <Show
            when={(days() ?? []).length > 0}
            fallback={<div class="empty">No sessions captured yet.</div>}
          >
            <For each={days() ?? []}>
              {(d) => {
                const list = (): TermLogSessionMeta[] => sessionsByDay()?.get(d.day) ?? [];
                return (
                  <div class="logs-day-group">
                    <div class="logs-day-header">{d.day}</div>
                    <Show
                      when={list().length > 0}
                      fallback={<div class="logs-day-empty">No sessions.</div>}
                    >
                      <ul class="logs-day-sessions">
                        <For each={list()}>
                          {(sess) => (
                            <SessionCard sess={sess} onOpen={() => setActivePath(sess.path)} />
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </Show>
      </section>
    </div>
  );
}

function SessionCard(props: { sess: TermLogSessionMeta; onOpen: () => void }): JSX.Element {
  const isFailure = (): boolean =>
    typeof props.sess.exitCode === 'number' && props.sess.exitCode !== 0;
  const isRunning = (): boolean => props.sess.exitCode === undefined;
  return (
    <li>
      <button
        type="button"
        class="logs-session-card"
        classList={{ running: isRunning(), failed: isFailure() }}
        onClick={props.onOpen}
      >
        <span class="logs-session-time">{props.sess.time}</span>
        <Show when={props.sess.repo}>
          <span class="logs-session-repo">{props.sess.repo}</span>
        </Show>
        <span class="logs-session-cmd">{props.sess.cmd ?? '(no command)'}</span>
        <span class="logs-session-size">{formatBytes(props.sess.bytes)}</span>
        <span class="logs-session-exit">
          {isRunning() ? 'running' : `exit ${props.sess.exitCode}`}
        </span>
      </button>
    </li>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
