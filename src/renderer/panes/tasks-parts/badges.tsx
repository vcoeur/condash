import { Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { isAppToken, isProjectToken, type Marker } from '@shared/tasks';

/** Task card's agent chip: the resolved agent id, or a "missing" badge when the
 *  referenced agent is no longer defined in settings. */
export function AgentBadge(props: { agent: string; present: boolean }): JSX.Element {
  return (
    <Show
      when={props.present}
      fallback={
        <span class="tasks-agent tasks-agent-missing" title={`Agent ${props.agent} is not defined`}>
          {props.agent} missing
        </span>
      }
    >
      <span class="tasks-agent tasks-agent-ok">{props.agent}</span>
    </Show>
  );
}

/** One marker chip — `{APP}` / `{PROJECT}` / a plain field — coloured by kind. */
export function MarkerChip(props: { marker: Marker }): JSX.Element {
  const kind = (): string => {
    if (isAppToken(props.marker.key)) return 'app';
    if (isProjectToken(props.marker.key)) return 'project';
    return 'field';
  };
  return (
    <span class="tasks-marker" data-kind={kind()} title={`${kind()} marker`}>
      {`{${props.marker.key}}`}
    </span>
  );
}
