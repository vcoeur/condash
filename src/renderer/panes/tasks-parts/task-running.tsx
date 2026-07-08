import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { RunningTaskRun } from '@shared/types';
import type { TaskListItem } from '@shared/tasks';
import { formatElapsed, tailText } from './data';
import { Caret } from '../../icons';

/** "Running" section — the live headless scheduled runs, mirroring the Code
 *  pane's active-runs dock. Each row shows the task, how long it has been
 *  running, an expandable tail of its segregated log, and a Kill button. */
export function TaskRunning(props: {
  runs: () => readonly RunningTaskRun[];
  tasks: () => readonly TaskListItem[];
  onKill: (sid: string) => void;
}): JSX.Element {
  // A 1s clock so the elapsed time ticks (and an expanded row re-tails its log)
  // — but only while runs exist. An idle Tasks pane (the common case, now that
  // the roster arrives on a push) spins no timer and re-tails nothing (B5).
  const [now, setNow] = createSignal(Date.now());
  const hasRuns = createMemo(() => props.runs().length > 0);
  createEffect(() => {
    if (!hasRuns()) return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(clock));
  });
  const nameFor = (slug: string): string =>
    props.tasks().find((t) => t.slug === slug)?.name ?? slug;

  return (
    <Show when={props.runs().length > 0}>
      <section class="tasks-running">
        <h2 class="tasks-running-header">
          <span class="name">RUNNING</span>
          <span class="count">{props.runs().length}</span>
        </h2>
        <div class="tasks-running-list">
          <For each={props.runs()}>
            {(run) => (
              <RunningRunRow
                run={run}
                name={nameFor(run.slug)}
                now={now}
                onKill={() => props.onKill(run.sid)}
              />
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}

/** One live-run row: collapsed by default; expanding tails its log file. */
function RunningRunRow(props: {
  run: RunningTaskRun;
  name: string;
  now: () => number;
  onKill: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const [log, setLog] = createSignal('');
  const elapsed = createMemo(() => formatElapsed(props.now() - props.run.startedAt));

  // While expanded, re-read the segregated run log on each clock tick so the
  // tail follows the live output. `logsReadSession` already strips the
  // `# condash:` header and returns the rendered body.
  createEffect(() => {
    if (!expanded() || !props.run.logPath) return;
    props.now();
    void window.condash
      .logsReadSession(props.run.logPath)
      .then((r) => setLog(tailText(r.text)))
      .catch(() => undefined);
  });

  return (
    <article class="tasks-run-row" classList={{ expanded: expanded() }}>
      <header
        class="tasks-run-head"
        role="button"
        tabIndex={0}
        aria-expanded={expanded()}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          const target = e.target as HTMLElement | null;
          if (target?.closest('button')) return;
          e.preventDefault();
          setExpanded((v) => !v);
        }}
      >
        <Caret expanded={expanded()} />
        <span class="dot" aria-hidden="true" />
        <span class="slug">{props.name}</span>
        <span class="status status-live">running</span>
        <span class="elapsed">{elapsed()}</span>
        <span class="spacer" />
        <button
          type="button"
          class="tasks-danger tasks-run-kill"
          title="Kill and discard this run"
          onClick={(e) => {
            e.stopPropagation();
            props.onKill();
          }}
        >
          Kill
        </button>
      </header>
      <Show when={expanded()}>
        <pre class="tasks-run-log">{log() || '(no output yet)'}</pre>
      </Show>
    </article>
  );
}
