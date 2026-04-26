import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { TermSide, TermSpawnRequest } from '@shared/types';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal-pane.css';

export interface Tab {
  id: string;
  side: TermSide;
  label: string;
  /** Set when the underlying pty has exited; the tab can still be cleared via close. */
  exited?: number;
}

export interface TerminalPaneHandle {
  spawn(request: TermSpawnRequest, label: string): Promise<string>;
  switchTo(side: TermSide, id?: string): void;
  /** Add a fresh user shell tab to "My terms". */
  spawnUserShell(): Promise<string>;
  /** Move the active tab within its side strip. */
  moveActiveTab(direction: -1 | 1): void;
}

export function TerminalPane(props: {
  open: boolean;
  onClose: () => void;
  registerHandle: (handle: TerminalPaneHandle | null) => void;
}) {
  const [side, setSide] = createSignal<TermSide>('my');
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [active, setActive] = createSignal<{ my: string | null; code: string | null }>({
    my: null,
    code: null,
  });

  let host: HTMLDivElement | undefined;
  const xterms = new Map<string, { term: Terminal; fit: FitAddon; element: HTMLDivElement }>();

  const setActiveFor = (sd: TermSide, id: string | null) => {
    setActive((prev) => ({ ...prev, [sd]: id }));
  };

  const visibleTabs = (): Tab[] => tabs().filter((t) => t.side === side());

  const activeId = (): string | null => active()[side()];

  const spawn = async (request: TermSpawnRequest, label: string): Promise<string> => {
    const { id } = await window.condash.termSpawn(request);
    const newTab: Tab = { id, side: request.side, label };
    setTabs((prev) => [...prev, newTab]);

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

    term.onData((data) => {
      void window.condash.termWrite(id, data);
    });
    term.onResize(({ cols, rows }) => {
      void window.condash.termResize(id, cols, rows);
    });

    xterms.set(id, { term, fit, element });
    setActiveFor(request.side, id);
    setSide(request.side);
    queueMicrotask(() => focusActive());
    return id;
  };

  const spawnUserShell = async (): Promise<string> => {
    const stamp = new Date().toLocaleTimeString();
    return spawn({ side: 'my' }, `shell · ${stamp}`);
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
    for (const [id, { term, element }] of xterms) {
      void window.condash.termClose(id);
      term.dispose();
      element.remove();
    }
    xterms.clear();
  });

  const closeTab = (id: string) => {
    void window.condash.termClose(id);
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
  };

  onMount(() => props.registerHandle(handle));
  onCleanup(() => props.registerHandle(null));

  return (
    <Show when={props.open}>
      <section class="terminal-pane">
        <header class="terminal-toolbar">
          <div class="terminal-side-toggle">
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
                  }}
                  onClick={() => setActiveFor(tab.side, tab.id)}
                >
                  <span class="terminal-tab-label" title={tab.label}>
                    {tab.label}
                  </span>
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
            <Show when={side() === 'my'}>
              <button
                class="terminal-tab-add"
                onClick={() => void spawnUserShell()}
                title="New shell tab"
              >
                +
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

function themeFromCss(): { background: string; foreground: string } {
  const css = getComputedStyle(document.documentElement);
  return {
    background: css.getPropertyValue('--bg-elevated').trim() || '#1f1f23',
    foreground: css.getPropertyValue('--text').trim() || '#ececf1',
  };
}
