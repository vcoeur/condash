import { createEffect, createResource, createSignal, For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { TermLogEvent, TermLogSessionMeta } from '@shared/types';
import { ConfirmModal } from '../confirm-modal';
import {
  buildRenderedItems,
  searchableText,
  type RenderedItem,
  type ReplaySegmentRenderer,
} from './logs-replay';
import './logs-pane.css';

/**
 * Logs pane — browse `<conception>/.condash/logs/`.
 *
 * Layout:
 *   - Row 1: Day select · Session select · Refresh · Delete session.
 *   - Row 2: Search box (substring match against rendered event text).
 *   - Body: events for the selected session. Contiguous `out` events are
 *     replayed through an off-screen xterm + SerializeAddon (same recipe
 *     the live pane's Save-buffer button uses) and shown as a single
 *     rendered transcript block; `in` / `spawn` / `exit` / `rotate`
 *     events render as one-line rows above and below the transcript.
 *
 * Why replay (and not just ANSI-strip the bytes): TUIs like Claude Code
 * emit constant cursor-positioning + line-erase sequences for the
 * spinner and bottom status bar. Stripping ANSI but keeping the literal
 * `\n`s between repaints scatters each frame's glyphs down separate
 * lines — unreadable. Feeding the raw bytes into an off-screen
 * `Terminal` resolves all the cursor motion to the final screen state.
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

  // Walk events through the xterm replay pipeline. Each session-file
  // load constructs a fresh `XtermSegmentRenderer`; it's disposed inside
  // `buildRenderedItems` after the final segment.
  const [renderedItems] = createResource(
    () => events(),
    async (evs): Promise<RenderedItem[]> => {
      if (!evs || evs.length === 0) return [];
      const renderer = new XtermSegmentRenderer();
      return buildRenderedItems(evs, renderer);
    },
  );

  // Free-text search box. Substring match (case-insensitive) against
  // each item's searchable text — for event rows that's the canonical
  // event body; for transcript blocks it's the rendered terminal text.
  const [query, setQuery] = createSignal('');

  const filteredItems = createMemo<RenderedItem[]>(() => {
    const all = renderedItems() ?? [];
    const q = query().trim().toLowerCase();
    if (q.length === 0) return all;
    return all.filter((item) => searchableText(item).toLowerCase().includes(q));
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
                    when={renderedItems.loading || renderedItems() !== undefined}
                    fallback={<div class="empty">Rendering…</div>}
                  >
                    <Show
                      when={filteredItems().length > 0}
                      fallback={
                        <div class="empty">
                          No matches for "{query()}" ({renderedItems()?.length ?? 0} items).
                        </div>
                      }
                    >
                      <For each={filteredItems()}>
                        {(item) =>
                          item.kind === 'transcript' ? (
                            <TranscriptBlock item={item} />
                          ) : (
                            <EventRow ev={item.ev} />
                          )
                        }
                      </For>
                    </Show>
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

function TranscriptBlock(props: {
  item: Extract<RenderedItem, { kind: 'transcript' }>;
}): JSX.Element {
  return (
    <div class="logs-event logs-event--transcript">
      <span class="logs-event-ts">{props.item.firstTs.slice(11, 23)}</span>
      <span class="logs-event-kind">out</span>
      <span class="logs-event-body logs-event-body--transcript">{props.item.text}</span>
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
  if (ev.kind === 'in') {
    return ev.text ?? ev.data ?? '';
  }
  if (ev.kind === 'exit') {
    return `exitCode=${ev.exitCode ?? '?'}`;
  }
  if (ev.kind === 'rotate') {
    return `rotated from ${ev.from ?? ''} to ${ev.to ?? ''}`;
  }
  return '';
}

/**
 * Xterm-backed implementation of `ReplaySegmentRenderer`. Constructs a
 * fresh `Terminal` per segment with `SerializeAddon` loaded, never
 * calls `.open()` (so no DOM is touched), and reads the rendered buffer
 * via `serialize.serialize()` — exactly the recipe the live pane's
 * Save-buffer button (`terminal-pane.tsx:444-456`) uses.
 *
 * 200×50 geometry is generous enough for any Claude Code TUI; if a
 * future user's live terminal is wider the replay will re-wrap, which
 * we accept as cosmetic.
 */
class XtermSegmentRenderer implements ReplaySegmentRenderer {
  private term: Terminal | null = null;
  private serializeAddon: SerializeAddon | null = null;

  start(): void {
    this.disposeTerm();
    const term = new Terminal({
      cols: 200,
      rows: 50,
      allowProposedApi: true,
      scrollback: 10000,
    });
    const addon = new SerializeAddon();
    term.loadAddon(addon);
    this.term = term;
    this.serializeAddon = addon;
  }

  write(data: string): void {
    this.term?.write(data);
  }

  async serialize(): Promise<string> {
    const term = this.term;
    const addon = this.serializeAddon;
    if (!term || !addon) return '';
    // `term.write` queues parsing; we need its callback to fire before
    // reading the buffer or we'll serialise a pre-parse view of the
    // last chunk. An empty write with a callback flushes the parser.
    await new Promise<void>((resolve) => term.write('', () => resolve()));
    return addon.serialize();
  }

  dispose(): void {
    this.disposeTerm();
  }

  private disposeTerm(): void {
    try {
      this.term?.dispose();
    } catch {
      /* xterm's dispose can throw if already torn down; never fatal */
    }
    this.term = null;
    this.serializeAddon = null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
