import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from 'solid-js';
import { AnsiUp } from 'ansi_up';
import type {
  LogsOpenRequest,
  TermLogSessionMeta,
  TermLogSessionRead,
  TerminalPrefs,
} from '@shared/types';
import { expandCursorForward } from '../../shared/expand-cursor-forward';
import { ConfirmModal } from '../confirm-modal';
import { createDropdownMenu } from '../dropdown-menu';
import './logs-pane.css';

/**
 * Logs pane — browse `<conception>/.condash/logs/`.
 *
 * Layout:
 *   - Row 1: Day picker · Session picker · Refresh · Delete session.
 *   - Row 2: Search box + n/N count + prev/next jump.
 *   - Body: header line with cmd / exit / repo, then the rendered
 *     transcript (one `<div class="logs-line">` per terminal line, styled
 *     via `ansi_up` with `use_classes: true` so the pane palette tracks
 *     the live xterm theme via CSS variables).
 *
 * Default selection: most recent session globally — the lister returns
 * days newest-first and sessions chronologically within a day, so on
 * first mount we pick `sessions[sessions.length - 1]` of the first day.
 *
 * Soft-wrap: `.logs-transcript` is `white-space: pre-wrap;
 * overflow-wrap: anywhere;` so no horizontal scroll. A ResizeObserver
 * flags lines that wrapped (`data-wrapped="true"`) so CSS can paint a
 * `↪` continuation glyph in the left gutter — one glyph per logical
 * line that wrapped, not per visual continuation row.
 *
 * Search: case-insensitive substring; the transcript is always rendered
 * and matches are wrapped with `<mark class="logs-search-hit">`. Prev /
 * next buttons scroll the active hit into view. No filter mode — a miss
 * just leaves the count at 0 and the transcript visible.
 *
 * Palette: the renderer reads the active xterm prefs (conception → global)
 * and writes them as `--logs-palette-*` CSS custom properties on the
 * pane root, mirroring what `xterm-mount.ts` does for live terminals.
 */
export function LogsView(props: {
  /** Bridge from the main app — every `searchModal` activation of a log
   * hit posts a request here so the pane can swap day + session. */
  openRequest?: Accessor<LogsOpenRequest | null>;
  /** xterm prefs (conception → global) — used to paint ANSI colors so
   * the rendered transcript matches the live tab's palette. */
  xtermPrefs?: Accessor<TerminalPrefs['xterm'] | undefined>;
}): JSX.Element {
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

  // Default selection: most recent session globally. The lister returns
  // sessions in start-time ascending order, so the last entry is the
  // most recent of the current day. The day select itself is already
  // sorted newest-first by the IPC layer.
  createEffect(() => {
    const list = sessions();
    if (!list) return;
    const current = selectedSession();
    if (current && list.some((s) => s.path === current.path)) return;
    setSelectedSession(list.length > 0 ? list[list.length - 1] : null);
  });

  const [sessionRead, { refetch: refetchSessionRead }] = createResource(
    () => selectedSession(),
    (sess): Promise<TermLogSessionRead> => {
      if (!sess) return Promise.resolve({ text: '', meta: null });
      return window.condash.logsReadSession(sess.path);
    },
  );

  const [query, setQuery] = createSignal('');

  // ansi_up output, with `use_classes: true` so we map .ansi-* classes
  // onto the xterm palette via CSS vars. Newlines stay as newlines —
  // `lineHtml()` later partitions the result into per-line divs so a
  // continuation glyph can be drawn in the gutter on lines that wrapped.
  const ansiHtml = createMemo<string>(() => {
    const read = sessionRead();
    if (!read || !read.text) return '';
    const ansi = new AnsiUp();
    ansi.use_classes = true;
    return ansi.ansi_to_html(expandCursorForward(read.text));
  });

  // Per-line HTML for the transcript. Splits on `\n` (ansi_up emits
  // literal newlines outside spans for serialized xterm buffers); each
  // line becomes a `<div class="logs-line">` whose innerHTML is the
  // line's coloured HTML. Empty lines get `&nbsp;` so they retain height.
  const lineHtml = createMemo<string[]>(() => {
    const html = ansiHtml();
    if (!html) return [];
    return html.split('\n').map((l) => (l.length > 0 ? l : '&nbsp;'));
  });

  // Hit-count + active-hit tracking. Recomputed whenever the query or
  // the rendered text changes. Match is plain case-insensitive substring
  // on the *post-expansion* text (Q3.2).
  const hitCount = createMemo<number>(() => {
    const read = sessionRead();
    const q = query().trim().toLowerCase();
    if (!read || !read.text || q.length === 0) return 0;
    const haystack = expandCursorForward(read.text).toLowerCase();
    let count = 0;
    let cursor = 0;
    while (cursor < haystack.length) {
      const idx = haystack.indexOf(q, cursor);
      if (idx === -1) break;
      count++;
      cursor = idx + q.length;
    }
    return count;
  });

  const [activeHit, setActiveHit] = createSignal(0);
  createEffect(() => {
    // Reset cursor on new query or session.
    query();
    selectedSession();
    setActiveHit(0);
  });

  // DOM container for the transcript. Search highlighting + wrap detection
  // both walk this element after each render.
  let transcriptEl: HTMLPreElement | undefined;
  let paneRootEl: HTMLDivElement | undefined;

  const applyActiveHit = (): void => {
    if (!transcriptEl) return;
    const marks = transcriptEl.querySelectorAll('mark.logs-search-hit');
    if (marks.length === 0) return;
    const idx = ((activeHit() % marks.length) + marks.length) % marks.length;
    marks.forEach((m, i) => {
      if (i === idx) m.classList.add('active');
      else m.classList.remove('active');
    });
    const active = marks.item(idx);
    if (active instanceof HTMLElement) {
      active.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  };

  // Highlight pass. Wraps every match in `<mark class="logs-search-hit">`,
  // then assigns `.active` to the one indexed by activeHit. Walks text
  // nodes only — never disturbs `<span>` ANSI spans.
  createEffect(() => {
    // Re-run when either signal changes.
    void lineHtml();
    const q = query().trim().toLowerCase();
    if (!transcriptEl) return;
    // Drop any prior marks first — replace each <mark>'s contents with a
    // text node carrying the same string, then merge adjacent text nodes.
    const existing = transcriptEl.querySelectorAll('mark.logs-search-hit');
    for (const mark of existing) {
      const text = document.createTextNode(mark.textContent ?? '');
      mark.replaceWith(text);
    }
    transcriptEl.normalize();
    if (q.length === 0) return;
    highlightInElement(transcriptEl, q);
    applyActiveHit();
  });

  // After lineHtml changes, give the layout a frame and then mark which
  // .logs-line elements wrapped. Re-run on container resize so we follow
  // pane width changes. ResizeObserver is fine here — the cost is O(n)
  // per resize event with n = visible line count.
  let lineResizeObserver: ResizeObserver | null = null;
  createEffect(() => {
    void lineHtml();
    if (!transcriptEl) return;
    queueMicrotask(() => {
      if (transcriptEl) updateWrappedFlags(transcriptEl);
    });
  });
  createEffect(() => {
    if (!transcriptEl) return;
    lineResizeObserver?.disconnect();
    const el = transcriptEl;
    lineResizeObserver = new ResizeObserver(() => updateWrappedFlags(el));
    lineResizeObserver.observe(el);
  });
  onCleanup(() => {
    lineResizeObserver?.disconnect();
    lineResizeObserver = null;
  });

  // Re-apply the active mark whenever the index changes (e.g. after
  // prev / next click) — the highlight effect above only paints the
  // marks themselves.
  createEffect(() => {
    activeHit();
    applyActiveHit();
  });

  const stepHit = (direction: -1 | 1): void => {
    const n = hitCount();
    if (n === 0) return;
    setActiveHit((cur) => (((cur + direction) % n) + n) % n);
  };

  // Paint xterm-palette CSS vars on the pane root so .ansi-* classes
  // resolve against the same colors the live terminal uses. Mirrors the
  // resolution in xterm-mount.ts:buildTheme — keeps the two surfaces in
  // sync without coupling at import-time.
  createEffect(() => {
    if (!paneRootEl) return;
    const xterm = props.xtermPrefs?.();
    applyLogsPalette(paneRootEl, xterm);
  });

  // External "open this session" requests from the global-search modal.
  // The request carries the absolute `.txt` (or `.txt.gz`) path; we
  // derive day + meta from the lister so the dropdowns update.
  createEffect(() => {
    const req = props.openRequest?.();
    if (!req) return;
    void openSessionByPath(req.path);
  });

  const openSessionByPath = async (path: string): Promise<void> => {
    const day = deriveDayFromPath(path);
    if (!day) return;
    setSelectedDay(day);
    // Wait one microtask so the sessions resource re-resolves, then pick
    // the entry matching the requested path.
    queueMicrotask(async () => {
      const list = await window.condash.logsListSessions(day);
      const match = list.find((m) => m.path === path) ?? null;
      if (match) setSelectedSession(match);
    });
  };

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
    <div class="logs-pane" ref={paneRootEl}>
      <div class="logs-toolbar">
        <div class="logs-toolbar-row">
          <div class="logs-picker">
            <span class="logs-picker-label">Day</span>
            <DayPicker
              days={() => days() ?? []}
              value={effectiveDay}
              onChange={(day) => {
                setSelectedDay(day);
                setSelectedSession(null);
              }}
            />
          </div>
          <div class="logs-picker logs-picker--session">
            <span class="logs-picker-label">Session</span>
            <SessionPicker
              sessions={() => sessions() ?? []}
              value={selectedSession}
              onChange={setSelectedSession}
            />
          </div>
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
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                stepHit(e.shiftKey ? -1 : 1);
              }
            }}
            disabled={!selectedSession()}
          />
          <Show when={query().trim().length > 0}>
            <span class="logs-hit-count">
              {hitCount() === 0 ? '0' : `${activeHit() + 1} / ${hitCount()}`}
            </span>
            <button
              type="button"
              class="logs-hit-step"
              onClick={() => stepHit(-1)}
              disabled={hitCount() === 0}
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
            >
              ↑
            </button>
            <button
              type="button"
              class="logs-hit-step"
              onClick={() => stepHit(1)}
              disabled={hitCount() === 0}
              title="Next match (Enter)"
              aria-label="Next match"
            >
              ↓
            </button>
          </Show>
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
                  <pre class="logs-transcript" ref={transcriptEl}>
                    <For each={lineHtml()}>
                      {(line) => <div class="logs-line" innerHTML={line} />}
                    </For>
                  </pre>
                </Show>
              </Show>
            </>
          )}
        </Show>
      </section>
    </div>
  );
}

/** Set xterm-palette CSS custom properties on the pane root so ansi_up's
 * `.ansi-*-fg` / `.ansi-*-bg` classes resolve against the same colors the
 * live terminal uses. Mirrors the resolution in `xterm-mount.ts:buildTheme`
 * — keeps the two surfaces in sync without import-time coupling. Falls
 * back to the xterm.js default 16-color palette when the user hasn't set
 * one. */
function applyLogsPalette(root: HTMLElement, prefs: TerminalPrefs['xterm'] | undefined): void {
  const colors = (prefs?.colors ?? {}) as Record<string, string | undefined>;
  const set = (varName: string, value: string | undefined, fallback: string): void => {
    root.style.setProperty(varName, value ?? fallback);
  };
  set('--logs-bg', colors.background, 'var(--bg-elevated, #1f1f23)');
  set('--logs-fg', colors.foreground, 'var(--text, #ececf1)');
  set('--logs-black', colors.black, '#2e3436');
  set('--logs-red', colors.red, '#cc0000');
  set('--logs-green', colors.green, '#4e9a06');
  set('--logs-yellow', colors.yellow, '#c4a000');
  set('--logs-blue', colors.blue, '#3465a4');
  set('--logs-magenta', colors.magenta, '#75507b');
  set('--logs-cyan', colors.cyan, '#06989a');
  set('--logs-white', colors.white, '#d3d7cf');
  set('--logs-bright-black', colors.bright_black, '#555753');
  set('--logs-bright-red', colors.bright_red, '#ef2929');
  set('--logs-bright-green', colors.bright_green, '#8ae234');
  set('--logs-bright-yellow', colors.bright_yellow, '#fce94f');
  set('--logs-bright-blue', colors.bright_blue, '#729fcf');
  set('--logs-bright-magenta', colors.bright_magenta, '#ad7fa8');
  set('--logs-bright-cyan', colors.bright_cyan, '#34e2e2');
  set('--logs-bright-white', colors.bright_white, '#eeeeec');
}

/** Flag each `.logs-line` whose rendered height exceeds the single-line
 * height — those wrapped and earn the gutter glyph in CSS. */
function updateWrappedFlags(root: HTMLElement): void {
  const lines = root.querySelectorAll<HTMLElement>('.logs-line');
  if (lines.length === 0) return;
  const sample = lines.item(0) as HTMLElement | null;
  if (!sample) return;
  const lineHeight = sample.getBoundingClientRect().height;
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
  const threshold = lineHeight * 1.5;
  lines.forEach((el) => {
    if (el.getBoundingClientRect().height > threshold) {
      el.setAttribute('data-wrapped', 'true');
    } else if (el.hasAttribute('data-wrapped')) {
      el.removeAttribute('data-wrapped');
    }
  });
}

/** Wrap every case-insensitive occurrence of `needle` (lower-cased) in
 * `<mark class="logs-search-hit">`. Walks text nodes only so ANSI
 * `<span>` boundaries are never broken. Operates in place on `root`. */
function highlightInElement(root: HTMLElement, needle: string): void {
  if (needle.length === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      let parent: Node | null = node.parentNode;
      while (parent && parent !== root) {
        if (parent instanceof HTMLElement && parent.tagName === 'MARK') {
          return NodeFilter.FILTER_REJECT;
        }
        parent = parent.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n instanceof Text) textNodes.push(n);
  }
  for (const node of textNodes) {
    const text = node.nodeValue ?? '';
    const lower = text.toLowerCase();
    let cursor = 0;
    const parts: Array<{ start: number; end: number }> = [];
    while (cursor < lower.length) {
      const idx = lower.indexOf(needle, cursor);
      if (idx === -1) break;
      parts.push({ start: idx, end: idx + needle.length });
      cursor = idx + needle.length;
    }
    if (parts.length === 0) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const p of parts) {
      if (p.start > pos) {
        frag.appendChild(document.createTextNode(text.slice(pos, p.start)));
      }
      const mark = document.createElement('mark');
      mark.className = 'logs-search-hit';
      mark.textContent = text.slice(p.start, p.end);
      frag.appendChild(mark);
      pos = p.end;
    }
    if (pos < text.length) {
      frag.appendChild(document.createTextNode(text.slice(pos)));
    }
    node.replaceWith(frag);
  }
}

function deriveDayFromPath(filePath: string): string | null {
  // <root>/YYYY/MM/DD/HHMMSS-<sid>.txt(.gz)
  const m = /\/(\d{4})\/(\d{2})\/(\d{2})\/\d{6}-[^/]+\.txt(?:\.gz)?$/.exec(filePath);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

interface DayEntry {
  day: string;
  path: string;
}

function DayPicker(props: {
  days: () => DayEntry[];
  value: Accessor<string | null>;
  onChange: (day: string) => void;
}): JSX.Element {
  const menu = createDropdownMenu();
  const triggerLabel = (): string => props.value() ?? 'no logs';
  const disabled = (): boolean => props.days().length === 0;
  return (
    <>
      <button
        type="button"
        ref={menu.setTrigger}
        class="logs-dropdown-trigger"
        onClick={menu.toggle}
        disabled={disabled()}
        aria-haspopup="listbox"
        aria-expanded={menu.isOpen()}
      >
        <span class="logs-dropdown-value">{triggerLabel()}</span>
        <span class="logs-dropdown-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      <Show when={menu.isOpen() && menu.anchor()}>
        <div
          ref={menu.setMenu}
          class="logs-dropdown-menu portal"
          role="listbox"
          style={{
            top: `${menu.anchor()!.top}px`,
            left: `${menu.anchor()!.left}px`,
          }}
        >
          <For each={props.days()}>
            {(entry) => (
              <button
                type="button"
                class="logs-dropdown-item"
                classList={{ active: entry.day === props.value() }}
                role="option"
                aria-selected={entry.day === props.value()}
                onClick={() => {
                  menu.close();
                  props.onChange(entry.day);
                }}
              >
                {entry.day}
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

function SessionPicker(props: {
  sessions: () => TermLogSessionMeta[];
  value: Accessor<TermLogSessionMeta | null>;
  onChange: (sess: TermLogSessionMeta) => void;
}): JSX.Element {
  const menu = createDropdownMenu();
  const triggerLabel = (): string => {
    const sel = props.value();
    if (!sel) return 'no sessions';
    return sessionLabel(sel);
  };
  const disabled = (): boolean => props.sessions().length === 0;
  return (
    <>
      <button
        type="button"
        ref={menu.setTrigger}
        class="logs-dropdown-trigger logs-dropdown-trigger--session"
        onClick={menu.toggle}
        disabled={disabled()}
        aria-haspopup="listbox"
        aria-expanded={menu.isOpen()}
      >
        <span class="logs-dropdown-value">{triggerLabel()}</span>
        <span class="logs-dropdown-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      <Show when={menu.isOpen() && menu.anchor()}>
        <div
          ref={menu.setMenu}
          class="logs-dropdown-menu logs-dropdown-menu--session portal"
          role="listbox"
          style={{
            top: `${menu.anchor()!.top}px`,
            left: `${menu.anchor()!.left}px`,
          }}
        >
          <For each={props.sessions()}>
            {(meta) => (
              <button
                type="button"
                class="logs-dropdown-item"
                classList={{ active: meta.path === props.value()?.path }}
                role="option"
                aria-selected={meta.path === props.value()?.path}
                onClick={() => {
                  menu.close();
                  props.onChange(meta);
                }}
              >
                {sessionLabel(meta)}
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
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
