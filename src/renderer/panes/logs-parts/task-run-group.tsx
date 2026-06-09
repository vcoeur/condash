import { For, type JSX } from 'solid-js';
import type { TaskRunGroup } from '@shared/types';
import { formatBytes } from './data';

/** One task's run group in the "Task runs" view — a collapsible header with a
 *  trigger badge and a row per run, opening the same viewer as a session. */
export function TaskRunGroupView(props: {
  group: TaskRunGroup;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}): JSX.Element {
  return (
    <details class="logs-day-group" open>
      <summary class="logs-day-header">
        <span class="logs-caret" aria-hidden="true" />
        <span class="logs-day-label">{props.group.taskSlug}</span>
        <span class="logs-taskrun-trigger" data-trigger={props.group.trigger}>
          {props.group.trigger}
        </span>
        <span class="logs-group-count">{props.group.runs.length}</span>
      </summary>
      <ul class="logs-day-sessions">
        <For each={props.group.runs}>
          {(run) => (
            <li class="logs-session-li">
              <button
                type="button"
                class="logs-session-card"
                onClick={() => props.onOpen(run.path)}
              >
                <span class="logs-session-time">
                  {run.day} {run.time}
                </span>
                <span class="logs-session-cmd">{run.sid}</span>
                <span class="logs-session-size">{formatBytes(run.bytes)}</span>
              </button>
              <button
                type="button"
                class="logs-session-reveal"
                title="Reveal in file manager"
                aria-label="Reveal in file manager"
                onClick={() => props.onReveal(run.path)}
              >
                ⤷
              </button>
            </li>
          )}
        </For>
      </ul>
    </details>
  );
}
