import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import type { TermLogSessionMeta, TermLogSessionRead } from '@shared/types';
import './logs-modal.css';

/**
 * Full-overlay viewer for one saved session. Reads `.txt` over IPC,
 * shows a virtualised plain-text transcript with case-insensitive search.
 *
 * Virtualisation: fixed row height (CSS `--logs-row-height`). The outer
 * scroller carries `lines.length * rowHeight` via a spacer; only the
 * visible window (± overscan) is mounted as absolutely positioned
 * `<div>` rows. Cost is O(viewport), not O(transcript).
 *
 * Search: pre-built hit index of `{lineIdx, col, len}` from per-line
 * `indexOf`. Prev / next mutate the active hit and scroll the target
 * line into view; matches are rendered inline as JSX fragments per
 * visible row — no innerHTML, no DOM walking.
 */
export function LogsViewerModal(props: {
  path: string;
  onClose: () => void;
  onDelete: (sess: TermLogSessionMeta) => void;
}): JSX.Element {
  const [sessionRead] = createResource(
    () => props.path,
    async (path): Promise<TermLogSessionRead> => {
      return window.condash.logsReadSession(path);
    },
  );

  const [query, setQuery] = createSignal('');

  const lines = createMemo<string[]>(() => {
    const read = sessionRead();
    if (!read || !read.text) return [];
    return read.text.split('\n');
  });

  interface Hit {
    lineIdx: number;
    col: number;
    len: number;
  }
  const hits = createMemo<Hit[]>(() => {
    const arr = lines();
    const q = query().trim().toLowerCase();
    if (q.length === 0) return [];
    const out: Hit[] = [];
    for (let i = 0; i < arr.length; i++) {
      const lower = arr[i].toLowerCase();
      let cursor = 0;
      while (cursor < lower.length) {
        const idx = lower.indexOf(q, cursor);
        if (idx === -1) break;
        out.push({ lineIdx: i, col: idx, len: q.length });
        cursor = idx + q.length;
      }
    }
    return out;
  });

  const [activeHit, setActiveHit] = createSignal(0);
  createEffect(() => {
    query();
    setActiveHit(0);
  });

  const ROW_HEIGHT = 19.04; // matches `--logs-row-height` in logs-modal.css
  const OVERSCAN = 12;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(600);

  const totalHeight = createMemo(() => lines().length * ROW_HEIGHT);

  const visible = createMemo<{ idx: number; text: string }[]>(() => {
    const arr = lines();
    if (arr.length === 0) return [];
    const vh = Math.max(viewportHeight(), 1);
    const first = Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(arr.length, Math.ceil((scrollTop() + vh) / ROW_HEIGHT) + OVERSCAN);
    const out: { idx: number; text: string }[] = [];
    for (let i = first; i < last; i++) {
      out.push({ idx: i, text: arr[i] });
    }
    return out;
  });

  const hitsByLine = createMemo<Map<number, Hit[]>>(() => {
    const map = new Map<number, Hit[]>();
    for (const h of hits()) {
      const existing = map.get(h.lineIdx);
      if (existing) existing.push(h);
      else map.set(h.lineIdx, [h]);
    }
    return map;
  });

  let transcriptEl: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | null = null;

  const attachTranscript = (el: HTMLDivElement): void => {
    transcriptEl = el;
    setViewportHeight(el.clientHeight);
    setScrollTop(el.scrollTop);
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    resizeObserver.observe(el);
  };

  onCleanup(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  const onScroll = (e: Event): void => {
    const target = e.currentTarget as HTMLDivElement;
    setScrollTop(target.scrollTop);
  };

  // Centre the active hit's line in the viewport.
  createEffect(() => {
    const all = hits();
    if (all.length === 0) return;
    if (!transcriptEl) return;
    const target = all[activeHit() % all.length];
    if (!target) return;
    const desired = target.lineIdx * ROW_HEIGHT - transcriptEl.clientHeight / 2;
    transcriptEl.scrollTop = Math.max(0, desired);
  });

  const stepHit = (direction: -1 | 1): void => {
    const n = hits().length;
    if (n === 0) return;
    setActiveHit((cur) => (((cur + direction) % n) + n) % n);
  };

  // Esc closes; Cmd/Ctrl+F focuses the search box.
  let searchInput: HTMLInputElement | undefined;
  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      event.stopPropagation();
      searchInput?.focus();
      searchInput?.select();
    }
  };
  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal logs-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Session log"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head logs-modal-head">
          <span class="logs-modal-title">{titleFor(sessionRead())}</span>
          <span class="modal-path">{props.path}</span>
          <span class="modal-head-spacer" />
          <button
            type="button"
            class="modal-button"
            title="Delete this session"
            aria-label="Delete this session"
            disabled={!sessionRead()?.meta}
            onClick={() => {
              const meta = sessionRead()?.meta;
              if (meta) props.onDelete(meta);
            }}
          >
            ⌫
          </button>
          <button
            type="button"
            class="modal-button modal-close"
            onClick={props.onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div class="logs-modal-search">
          <input
            ref={searchInput}
            type="search"
            class="logs-search"
            placeholder="Search this session… (Cmd/Ctrl+F)"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stepHit(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <Show when={query().trim().length > 0}>
            <span class="logs-hit-count">
              {hits().length === 0 ? '0' : `${activeHit() + 1} / ${hits().length}`}
            </span>
            <button
              type="button"
              class="logs-hit-step"
              onClick={() => stepHit(-1)}
              disabled={hits().length === 0}
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
            >
              ↑
            </button>
            <button
              type="button"
              class="logs-hit-step"
              onClick={() => stepHit(1)}
              disabled={hits().length === 0}
              title="Next match (Enter)"
              aria-label="Next match"
            >
              ↓
            </button>
          </Show>
        </div>

        <Show when={!sessionRead.loading} fallback={<div class="empty">Loading…</div>}>
          <Show
            when={(sessionRead()?.text.length ?? 0) > 0}
            fallback={<div class="empty">Empty session.</div>}
          >
            <div class="logs-transcript" ref={attachTranscript} onScroll={onScroll}>
              <div class="logs-transcript-spacer" style={{ height: `${totalHeight()}px` }}>
                <For each={visible()}>
                  {(row) => (
                    <div class="logs-line" style={{ top: `${row.idx * ROW_HEIGHT}px` }}>
                      <LineContents
                        text={row.text}
                        hits={hitsByLine().get(row.idx) ?? []}
                        activeHit={hits()[activeHit()]}
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}

interface LineHit {
  lineIdx: number;
  col: number;
  len: number;
}

/** Render one line's text with case-insensitive search highlighting.
 * Pure JSX — no innerHTML, no DOM walk. Cost is O(hits-in-this-line). */
function LineContents(props: {
  text: string;
  hits: LineHit[];
  activeHit: LineHit | undefined;
}): JSX.Element {
  if (props.hits.length === 0) return <>{props.text}</>;
  const parts: JSX.Element[] = [];
  let cursor = 0;
  for (const h of props.hits) {
    if (h.col > cursor) parts.push(props.text.slice(cursor, h.col));
    const isActive =
      props.activeHit !== undefined &&
      props.activeHit.lineIdx === h.lineIdx &&
      props.activeHit.col === h.col;
    parts.push(
      <mark class={`logs-search-hit${isActive ? ' active' : ''}`}>
        {props.text.slice(h.col, h.col + h.len)}
      </mark>,
    );
    cursor = h.col + h.len;
  }
  if (cursor < props.text.length) parts.push(props.text.slice(cursor));
  return <>{parts}</>;
}

function titleFor(read: TermLogSessionRead | undefined): string {
  if (!read || !read.meta) return 'Session log';
  const meta = read.meta;
  const head = meta.repo ? `${meta.day} ${meta.time} · ${meta.repo}` : `${meta.day} ${meta.time}`;
  const cmd = meta.cmd ? ` · ${meta.cmd}` : '';
  const exit = meta.exitCode !== undefined ? ` · exit ${meta.exitCode}` : '';
  return `${head}${cmd}${exit}`;
}
