import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { TermSide, TermSpawnRequest } from '@shared/types';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal-pane.css';

export interface Tab {
  id: string;
  side: TermSide;
  /** Default label (auto-derived from spawn — e.g. repo name or shell). */
  label: string;
  /** User-renamed label, if any. Persisted by id in localStorage. */
  customName?: string;
  /** Set when the underlying pty has exited; the tab can still be cleared via close. */
  exited?: number;
}

/** Per-session metadata persisted across renderer reloads. Keyed by session id. */
interface PersistedTabMeta {
  label: string;
  customName?: string;
}

const META_KEY = 'condash-term-meta';

function readMeta(): Record<string, PersistedTabMeta> {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as Record<string, PersistedTabMeta>) : {};
  } catch {
    return {};
  }
}

function writeMeta(meta: Record<string, PersistedTabMeta>): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* ignore */
  }
}

function setMeta(id: string, value: PersistedTabMeta): void {
  const map = readMeta();
  map[id] = value;
  writeMeta(map);
}

function deleteMeta(id: string): void {
  const map = readMeta();
  delete map[id];
  writeMeta(map);
}

export interface TerminalPaneHandle {
  spawn(request: TermSpawnRequest, label: string): Promise<string>;
  switchTo(side: TermSide, id?: string): void;
  /** Add a fresh user shell tab to "My terms". */
  spawnUserShell(launcherCommand?: string | null, side?: TermSide): Promise<string>;
  /** Move the active tab within its side strip. */
  moveActiveTab(direction: -1 | 1): void;
  /** Type a literal string into the active terminal (no shell parsing). */
  typeIntoActive(text: string): void;
}

export function TerminalPane(props: {
  open: boolean;
  onClose: () => void;
  registerHandle: (handle: TerminalPaneHandle | null) => void;
  launcherCommand?: string | null;
}) {
  const [side, setSide] = createSignal<TermSide>('my');
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [active, setActive] = createSignal<{ my: string | null; code: string | null }>({
    my: null,
    code: null,
  });
  const [renamingId, setRenamingId] = createSignal<string | null>(null);

  const commitRename = (id: string, value: string) => {
    const trimmed = value.trim();
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, customName: trimmed || undefined } : t)),
    );
    const tab = tabs().find((t) => t.id === id);
    if (tab) {
      setMeta(id, { label: tab.label, customName: trimmed || undefined });
    }
    setRenamingId(null);
  };

  const tabDisplayLabel = (tab: Tab): string => tab.customName ?? tab.label;

  let host: HTMLDivElement | undefined;
  const xterms = new Map<string, { term: Terminal; fit: FitAddon; element: HTMLDivElement }>();

  const setActiveFor = (sd: TermSide, id: string | null) => {
    setActive((prev) => ({ ...prev, [sd]: id }));
  };

  const visibleTabs = (): Tab[] => tabs().filter((t) => t.side === side());

  const activeId = (): string | null => active()[side()];

  /** Build a freshly-mounted xterm for a session id. Used by both spawn (new
   * pty) and re-attach (existing pty surviving a renderer reload). */
  const mountXterm = (id: string, replay?: string): { fit: FitAddon } => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      theme: themeFromCss(),
      cursorBlink: true,
      scrollback: 4000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const element = document.createElement('div');
    element.className = 'xterm-host';
    element.style.display = 'none';
    if (host) host.appendChild(element);
    term.open(element);
    if (replay) term.write(replay);

    term.onData((data) => {
      void window.condash.termWrite(id, data);
    });
    term.onResize(({ cols, rows }) => {
      void window.condash.termResize(id, cols, rows);
    });

    xterms.set(id, { term, fit, element });
    return { fit };
  };

  const spawn = async (request: TermSpawnRequest, label: string): Promise<string> => {
    const { id } = await window.condash.termSpawn(request);
    const newTab: Tab = { id, side: request.side, label };
    setTabs((prev) => [...prev, newTab]);
    setMeta(id, { label });

    mountXterm(id);
    setActiveFor(request.side, id);
    setSide(request.side);
    queueMicrotask(() => focusActive());
    return id;
  };

  /** Re-attach to ptys that survived a renderer reload. Reads tab metadata
   * from localStorage and replays the buffered output that main has been
   * holding for us. Runs once on mount. */
  const reattachExistingSessions = async (): Promise<void> => {
    const sessions = await window.condash.termList();
    if (sessions.length === 0) return;
    const meta = readMeta();
    for (const s of sessions) {
      const persisted = meta[s.id];
      const label = persisted?.label ?? (s.repo ? `${s.repo} (run)` : 'shell');
      const tab: Tab = {
        id: s.id,
        side: s.side,
        label,
        customName: persisted?.customName,
        exited: s.exited,
      };
      setTabs((prev) => [...prev, tab]);
      const attach = await window.condash.termAttach(s.id);
      mountXterm(s.id, attach?.output);
    }
    // Restore the last-active selections per side, if any of those ids are
    // still around. Otherwise fall back to the most recent tab.
    setSide('my');
    const myTabs = sessions.filter((s) => s.side === 'my');
    const codeTabs = sessions.filter((s) => s.side === 'code');
    setActiveFor('my', myTabs.at(-1)?.id ?? null);
    setActiveFor('code', codeTabs.at(-1)?.id ?? null);
    queueMicrotask(focusActive);
  };

  onMount(() => {
    void reattachExistingSessions();
  });

  const spawnUserShell = async (
    launcherCommand?: string | null,
    sd: TermSide = 'my',
  ): Promise<string> => {
    const stamp = new Date().toLocaleTimeString();
    const label = launcherCommand?.trim() ? `${launcherCommand} · ${stamp}` : `shell · ${stamp}`;
    return spawn({ side: sd, command: launcherCommand?.trim() || undefined }, label);
  };

  const onTermData = window.condash.onTermData(({ id, data }) => {
    const handle = xterms.get(id);
    handle?.term.write(data);
  });
  const onTermExit = window.condash.onTermExit(({ id, code }) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, exited: code } : t)));
    const handle = xterms.get(id);
    if (handle) handle.term.write(`\r\n\x1b[33m[process exited ${code}]\x1b[0m\r\n`);
  });

  onCleanup(() => {
    onTermData();
    onTermExit();
    // Dispose the renderer-side xterm widgets but do *not* call termClose —
    // the underlying ptys are owned by main and survive renderer reloads, so
    // a freshly-loaded tab strip can re-attach via reattachExistingSessions.
    for (const [, { term, element }] of xterms) {
      term.dispose();
      element.remove();
    }
    xterms.clear();
  });

  const closeTab = (id: string) => {
    void window.condash.termClose(id);
    deleteMeta(id);
    const handle = xterms.get(id);
    handle?.term.dispose();
    handle?.element.remove();
    xterms.delete(id);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    // Pick a fallback active tab on the same side.
    const remaining = tabs().filter((t) => t.id !== id);
    const fallback = remaining.find((t) => t.side === side())?.id ?? null;
    setActiveFor(side(), fallback);
    queueMicrotask(focusActive);
  };

  const focusActive = () => {
    const id = activeId();
    if (!id) return;
    for (const [tid, { element }] of xterms) {
      element.style.display = tid === id ? 'flex' : 'none';
    }
    const handle = xterms.get(id);
    if (handle) {
      try {
        handle.fit.fit();
      } catch {
        /* not yet sized */
      }
      handle.term.focus();
    }
  };

  createEffect(() => {
    void side();
    void active();
    queueMicrotask(focusActive);
  });

  // Re-fit whenever the pane opens or the window resizes.
  const onWindowResize = (): void => {
    for (const { fit } of xterms.values()) {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    }
  };
  onMount(() => {
    window.addEventListener('resize', onWindowResize);
  });
  onCleanup(() => window.removeEventListener('resize', onWindowResize));

  createEffect(() => {
    if (props.open) queueMicrotask(focusActive);
  });

  const handle: TerminalPaneHandle = {
    spawn,
    switchTo: (sd, id) => {
      setSide(sd);
      if (id) setActiveFor(sd, id);
      queueMicrotask(focusActive);
    },
    spawnUserShell,
    moveActiveTab: (direction) => {
      const sd = side();
      const ids = tabs()
        .filter((t) => t.side === sd)
        .map((t) => t.id);
      const idx = ids.indexOf(active()[sd] ?? '');
      if (idx === -1) return;
      const nextIdx = (idx + direction + ids.length) % ids.length;
      setActiveFor(sd, ids[nextIdx]);
      queueMicrotask(focusActive);
    },
    typeIntoActive: (text) => {
      const id = activeId();
      if (!id) return;
      void window.condash.termWrite(id, text);
    },
  };

  onMount(() => props.registerHandle(handle));
  onCleanup(() => props.registerHandle(null));

  return (
    <Show when={props.open}>
      <section class="terminal-pane">
        <header class="terminal-toolbar">
          <div class="terminal-side-toggle" data-active-side={side()}>
            <button
              class="modal-button"
              classList={{ active: side() === 'my' }}
              onClick={() => {
                setSide('my');
                queueMicrotask(focusActive);
              }}
            >
              My terms
            </button>
            <button
              class="modal-button"
              classList={{ active: side() === 'code' }}
              onClick={() => {
                setSide('code');
                queueMicrotask(focusActive);
              }}
            >
              Code run terms
            </button>
          </div>
          <div class="terminal-tabs">
            <For each={visibleTabs()}>
              {(tab) => (
                <div
                  class="terminal-tab"
                  classList={{
                    active: tab.id === activeId(),
                    exited: tab.exited !== undefined,
                    renaming: tab.id === renamingId(),
                  }}
                  onClick={() => setActiveFor(tab.side, tab.id)}
                  onDblClick={(e) => {
                    if ((e.target as HTMLElement).closest('.terminal-tab-close')) return;
                    setRenamingId(tab.id);
                  }}
                  title={tabDisplayLabel(tab) === tab.label ? tab.label : `${tab.label} (renamed)`}
                >
                  <Show
                    when={tab.id === renamingId()}
                    fallback={<span class="terminal-tab-label">{tabDisplayLabel(tab)}</span>}
                  >
                    <input
                      class="terminal-tab-rename"
                      type="text"
                      value={tabDisplayLabel(tab)}
                      ref={(el) => queueMicrotask(() => el && (el.focus(), el.select()))}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => commitRename(tab.id, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRename(tab.id, e.currentTarget.value);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setRenamingId(null);
                        }
                        e.stopPropagation();
                      }}
                    />
                  </Show>
                  <button
                    class="terminal-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    title="Close tab"
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
            <button
              class="terminal-tab-add"
              onClick={() => {
                if (side() === 'my') void spawnUserShell(props.launcherCommand);
                else void spawnUserShell(props.launcherCommand, 'code');
              }}
              title={
                side() === 'my'
                  ? props.launcherCommand
                    ? `New tab (${props.launcherCommand})`
                    : 'New shell tab'
                  : 'New code-side shell tab'
              }
            >
              +
            </button>
          </div>
          <button class="modal-button" onClick={props.onClose} title="Close pane">
            ×
          </button>
        </header>
        <div class="terminal-host" ref={(el) => (host = el)} />
      </section>
    </Show>
  );
}

function themeFromCss(): { background: string; foreground: string } {
  const css = getComputedStyle(document.documentElement);
  return {
    background: css.getPropertyValue('--bg-elevated').trim() || '#1f1f23',
    foreground: css.getPropertyValue('--text').trim() || '#ececf1',
  };
}
