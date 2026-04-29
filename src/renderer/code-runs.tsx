// Inline runner rows for the Code tab. Each surfaces one code-side terminal
// session — typically a `make run` started via the repo's Run button — with
// repo / branch metadata, a collapsible mini xterm (~20 lines), and a pop-out
// button that re-sides the session to "my" so it lives in the bottom pane.

import { createEffect, createSignal, createMemo, For, onCleanup, Show } from 'solid-js';
import type { TermSession, RepoEntry, Worktree } from '@shared/types';
import { mountXterm } from './xterm-mount';

interface CodeRunRowsProps {
  sessions: readonly TermSession[];
  repos: readonly RepoEntry[];
  onClose: (id: string) => void;
}

export function CodeRunRows(props: CodeRunRowsProps) {
  return (
    <Show when={props.sessions.length > 0}>
      <section class="code-runs">
        <h2 class="repos-group-header">
          <span class="name">ACTIVE RUNS</span>
          <span class="count">{props.sessions.length}</span>
          <span class="rule" />
        </h2>
        <div class="code-runs-list">
          <For each={props.sessions}>
            {(session) => (
              <CodeRunRow
                session={session}
                repos={props.repos}
                onClose={() => props.onClose(session.id)}
              />
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}

function repoMeta(
  repos: readonly RepoEntry[],
  name: string | undefined,
): { repo?: RepoEntry; branch?: string } {
  if (!name) return {};
  const repo = repos.find((r) => r.name === name);
  if (!repo) return {};
  // The "primary" worktree is the one that lives at the configured repo
  // path. Its branch is the active checkout shown next to the repo name.
  const primary: Worktree | undefined = repo.worktrees?.find((w) => w.primary);
  return { repo, branch: primary?.branch ?? undefined };
}

function CodeRunRow(props: {
  session: TermSession;
  repos: readonly RepoEntry[];
  onClose: () => void;
}) {
  // Active-run rows start collapsed — the user may have many running, and an
  // auto-expanded xterm grabs vertical space they didn't ask for. Click the
  // header to peek in.
  const [expanded, setExpanded] = createSignal(false);
  const meta = createMemo(() => repoMeta(props.repos, props.session.repo));

  // Build the xterm element once and re-park it under the row's host every
  // time the row is expanded. Disposing on collapse loses the live stream
  // and the scrollback — which the previous version did, leaving an empty
  // terminal after expand/collapse cycles.
  const xtermElement = document.createElement('div');
  xtermElement.className = 'xterm-host';
  let host: HTMLDivElement | undefined;
  let mounted: ReturnType<typeof mountXterm> | null = null;
  let mountPromise: Promise<void> | null = null;

  const ensureMounted = (): Promise<void> => {
    if (mounted) return Promise.resolve();
    if (mountPromise) return mountPromise;
    mountPromise = (async () => {
      const attach = await window.condash.termAttach(props.session.id);
      mounted = mountXterm(xtermElement, props.session.id, { replay: attach?.output });
    })();
    return mountPromise;
  };

  // Re-attach the xterm element to whichever host node is currently mounted.
  // createEffect re-runs when expanded() flips back on.
  createEffect(() => {
    if (!expanded() || !host) return;
    void ensureMounted().then(() => {
      if (host && xtermElement.parentElement !== host) {
        host.appendChild(xtermElement);
      }
      requestAnimationFrame(() => {
        try {
          mounted?.fit.fit();
        } catch {
          /* host not laid out yet */
        }
      });
    });
  });

  // Stream live data into the local xterm. Buffered output is in main; the
  // live stream goes through onTermData regardless of expand state.
  const offData = window.condash.onTermData(({ id, data }) => {
    if (id !== props.session.id) return;
    mounted?.term.write(data);
  });
  const offExit = window.condash.onTermExit(({ id, code }) => {
    if (id !== props.session.id) return;
    mounted?.term.write(`\r\n\x1b[33m[process exited ${code}]\x1b[0m\r\n`);
  });

  onCleanup(() => {
    offData();
    offExit();
    mounted?.dispose();
    mounted = null;
    xtermElement.remove();
  });

  return (
    <article
      class="code-run-row"
      classList={{
        expanded: expanded(),
        exited: props.session.exited !== undefined,
      }}
    >
      <header class="code-run-head" onClick={() => setExpanded((v) => !v)}>
        <span class="caret" aria-hidden="true">
          {expanded() ? '▾' : '▸'}
        </span>
        <span class="dot" aria-hidden="true" />
        <span class="repo">{props.session.repo ?? '(detached)'}</span>
        <Show when={meta().branch}>
          <span class="branch">{meta().branch}</span>
        </Show>
        <Show
          when={props.session.exited === undefined}
          fallback={<span class="status status-exited">exited {props.session.exited}</span>}
        >
          <span class="status status-live">running</span>
        </Show>
        <span class="spacer" />
        <button
          class="repo-action stop"
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
          title="Stop and close row"
          aria-label="Stop"
        >
          ⏹
        </button>
      </header>
      <Show when={expanded()}>
        <div
          class="code-run-host"
          ref={(el) => {
            host = el;
          }}
        />
      </Show>
    </article>
  );
}
