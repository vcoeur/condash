import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { TermSide, TermSpawnRequest } from '@shared/types';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { mountXterm } from './xterm-mount';
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
  /** Optional launcher command (e.g. `claude`). When set, a second `+` button
   * spawns a shell that runs this command. */
  launcherCommand?: string | null;
  /** Working directory passed to spawned user shells (typically the
   * conception path). Defaults to $HOME on the main side. */
  cwd?: string | null;
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

  /** Bottom pane is "My terms"-only. Code-side sessions are surfaced on
   * the Code tab as inline runner rows; they don't appear here. */
  const visibleTabs = (): Tab[] => tabs().filter((t) => t.side === 'my');

  const activeId = (): string | null => active().my;

  /** Mount an xterm in the bottom pane for a session id. */
  const mountForSession = (id: string, replay?: string): { fit: FitAddon } => {
    const element = document.createElement('div');
    element.className = 'xterm-host';
    element.style.display = 'none';
    if (host) host.appendChild(element);
    const handle = mountXterm(element, id, { replay });
    xterms.set(id, { term: handle.term, fit: handle.fit, element });
    return { fit: handle.fit };
  };

  const spawn = async (request: TermSpawnRequest, label: string): Promise<string> => {
    const { id } = await window.condash.termSpawn(request);
    const newTab: Tab = { id, side: request.side, label };
    setTabs((prev) => [...prev, newTab]);
    setMeta(id, { label });

    if (request.side === 'my') {
      mountForSession(id);
      setActiveFor('my', id);
      setSide('my');
      queueMicrotask(() => focusActive());
    }
    return id;
  };

  /** Re-attach to my-side ptys that survived a renderer reload. Reads tab
   * metadata from localStorage and replays the buffered output that main
   * has been holding for us. Code-side sessions are owned by the Code tab
   * (CodeRunRow) and are not mounted here. */
  const reattachExistingSessions = async (): Promise<void> => {
    const sessions = (await window.condash.termList()).filter((s) => s.side === 'my');
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
      mountForSession(s.id, attach?.output);
    }
    setSide('my');
    setActiveFor('my', sessions.at(-1)?.id ?? null);
    queueMicrotask(focusActive);
  };

  // When a code-side session is "popped out" to my-side from the Code tab,
  // main re-broadcasts the session list with the new side. Pick up any
  // newly-my sessions whose tab we don't yet have, mount their xterms, and
  // replay the buffered tail.
  const offTermSessions = window.condash.onTermSessions((snap) => {
    void (async () => {
      const known = new Set(tabs().map((t) => t.id));
      for (const s of snap) {
        if (s.side !== 'my' || known.has(s.id)) continue;
        const meta = readMeta()[s.id];
        const label = meta?.label ?? (s.repo ? `${s.repo} (run)` : 'shell');
        const tab: Tab = {
          id: s.id,
          side: 'my',
          label,
          customName: meta?.customName,
          exited: s.exited,
        };
        setTabs((prev) => [...prev, tab]);
        const attach = await window.condash.termAttach(s.id);
        mountForSession(s.id, attach?.output);
        setActiveFor('my', s.id);
        queueMicrotask(focusActive);
      }
      // Drop tabs whose session has switched to 'code' (e.g. send-to-Code,
      // not a current feature but symmetric with pop-out) or has been
      // closed entirely.
      const live = new Set(snap.map((s) => s.id));
      for (const t of tabs()) {
        const stillMy = snap.find((s) => s.id === t.id && s.side === 'my');
        if (live.has(t.id) && stillMy) continue;
        // Session vanished or moved to code-side: drop the tab + xterm here.
        const handle = xterms.get(t.id);
        handle?.term.dispose();
        handle?.element.remove();
        xterms.delete(t.id);
        setTabs((prev) => prev.filter((x) => x.id !== t.id));
        if (active().my === t.id) {
          const remaining = tabs().filter((x) => x.id !== t.id);
          setActiveFor('my', remaining.at(-1)?.id ?? null);
        }
      }
    })();
  });
  onCleanup(offTermSessions);

  onMount(() => {
    void reattachExistingSessions();
  });

  /** Disambiguate `shell`, `shell (2)`, `shell (3)` etc. when several plain
   * shell tabs are open at once. */
  const uniqueLabel = (base: string): string => {
    const taken = new Set(tabs().map((t) => t.label));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} (${i})`;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  };

  const spawnUserShell = async (
    launcherCommand?: string | null,
    sd: TermSide = 'my',
  ): Promise<string> => {
    const base = launcherCommand?.trim() || 'shell';
    const label = uniqueLabel(base);
    return spawn(
      {
        side: sd,
        command: launcherCommand?.trim() || undefined,
        cwd: props.cwd ?? undefined,
      },
      label,
    );
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

  const onDragStart = (e: DragEvent, id: string) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData('application/x-condash-term-tab', id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOverTab = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('application/x-condash-term-tab')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDropOnTab = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    const srcId = e.dataTransfer?.getData('application/x-condash-term-tab');
    if (!srcId || srcId === targetId) return;
    setTabs((prev) => {
      const list = prev.slice();
      const srcIdx = list.findIndex((t) => t.id === srcId);
      const tgtIdx = list.findIndex((t) => t.id === targetId);
      if (srcIdx === -1 || tgtIdx === -1) return prev;
      const [moved] = list.splice(srcIdx, 1);
      const insertAt = list.findIndex((t) => t.id === targetId);
      list.splice(insertAt, 0, moved);
      return list;
    });
  };

  return (
    <Show when={props.open}>
      <section class="terminal-pane">
        <header class="terminal-toolbar">
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
                  draggable={tab.id !== renamingId()}
                  onDragStart={(e) => onDragStart(e, tab.id)}
                  onDragOver={onDragOverTab}
                  onDrop={(e) => onDropOnTab(e, tab.id)}
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
              onClick={() => void spawnUserShell(null, 'my')}
              title="New shell tab (cwd: conception)"
            >
              +
            </button>
            <Show when={props.launcherCommand?.trim()}>
              <button
                class="terminal-tab-add launcher"
                onClick={() => void spawnUserShell(props.launcherCommand, 'my')}
                title={`New ${props.launcherCommand} tab (cwd: conception)`}
              >
                +{props.launcherCommand}
              </button>
            </Show>
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
