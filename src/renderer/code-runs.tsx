// Inline runner rows for the Code tab. Each surfaces one code-side terminal
// session — typically a `make run` started via the repo's Run button — with
// repo / branch metadata, a collapsible mini xterm (~20 lines), and a pop-out
// button that re-sides the session to "my" so it lives in the bottom pane.

import { createSignal, createMemo, For, onCleanup, Show } from 'solid-js';
import type { TermSession, RepoEntry, Worktree } from '@shared/types';
import { mountXterm } from './xterm-mount';

interface CodeRunRowsProps {
  sessions: readonly TermSession[];
  repos: readonly RepoEntry[];
  onPopOut: (id: string) => void;
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
                onPopOut={() => props.onPopOut(session.id)}
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
  onPopOut: () => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = createSignal(true);
  const meta = createMemo(() => repoMeta(props.repos, props.session.repo));
  let host: HTMLDivElement | undefined;
  let mounted: ReturnType<typeof mountXterm> | null = null;

  // Mount xterm lazily when first expanded; replay buffered tail from main.
  const ensureMounted = async () => {
    if (mounted || !host) return;
    const attach = await window.condash.termAttach(props.session.id);
    mounted = mountXterm(host, props.session.id, {
      replay: attach?.output,
    });
    // Layout settles next frame; fit then so xterm picks up real cols/rows.
    requestAnimationFrame(() => {
      try {
        mounted?.fit.fit();
      } catch {
        /* host not laid out yet */
      }
    });
  };

  // Stream live data into the local xterm (only when this row owns the
  // session — i.e. before pop-out re-sides it).
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
          class="repo-action"
          onClick={(e) => {
            e.stopPropagation();
            props.onPopOut();
          }}
          title="Move to bottom pane (My terms)"
        >
          ↓ pop out
        </button>
        <button
          class="repo-action"
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
          title="Close session"
        >
          ✕
        </button>
      </header>
      <Show when={expanded()}>
        <div
          class="code-run-host"
          ref={(el) => {
            host = el;
            void ensureMounted();
          }}
        />
      </Show>
    </article>
  );
}
