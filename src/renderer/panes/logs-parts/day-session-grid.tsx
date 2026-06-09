import { For, Show, type JSX } from 'solid-js';
import type { TermLogSessionMeta } from '@shared/types';
import { SessionCard } from './session-card';

/** The session-card grid for one day, or an empty-state line. */
export function DaySessionGrid(props: {
  sessions: TermLogSessionMeta[];
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}): JSX.Element {
  return (
    <Show
      when={props.sessions.length > 0}
      fallback={<div class="logs-day-empty">No sessions.</div>}
    >
      <ul class="logs-day-sessions">
        <For each={props.sessions}>
          {(sess) => (
            <SessionCard
              sess={sess}
              onOpen={() => props.onOpen(sess.path)}
              onReveal={props.onReveal}
            />
          )}
        </For>
      </ul>
    </Show>
  );
}
