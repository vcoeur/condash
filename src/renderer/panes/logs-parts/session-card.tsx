import { Show, type JSX } from 'solid-js';
import type { TermLogSessionMeta } from '@shared/types';
import { formatBytes } from './data';

/** One session card: time · repo · cmd · size · exit, plus a sibling
 *  reveal-in-file-manager button (button-in-button is invalid HTML). */
export function SessionCard(props: {
  sess: TermLogSessionMeta;
  onOpen: () => void;
  onReveal: (path: string) => void;
}): JSX.Element {
  const isFailure = (): boolean =>
    typeof props.sess.exitCode === 'number' && props.sess.exitCode !== 0;
  // `exitCode === undefined` → no footer on disk → session genuinely alive.
  // `exitCode === null`      → footer was synthesised by the boot-time
  //                            orphan-seal sweep, real exit unknown but
  //                            the session is definitely *not* running.
  const isRunning = (): boolean => props.sess.exitCode === undefined;
  const isSealed = (): boolean => props.sess.exitSealed === true;
  const statusLabel = (): string => {
    if (isRunning()) return 'running';
    if (isSealed()) return 'ended ?';
    return `exit ${props.sess.exitCode}`;
  };
  const statusTitle = (): string | undefined => {
    if (!isSealed()) return undefined;
    return 'Session ended without a recorded exit code (condash exited or crashed before the footer could flush).';
  };
  return (
    <li class="logs-session-li">
      <button
        type="button"
        class="logs-session-card"
        classList={{ running: isRunning(), failed: isFailure(), sealed: isSealed() }}
        onClick={props.onOpen}
      >
        <span class="logs-session-time">{props.sess.time}</span>
        <Show when={props.sess.repo}>
          <span class="logs-session-repo">{props.sess.repo}</span>
        </Show>
        <span class="logs-session-cmd">{props.sess.cmd ?? '(no command)'}</span>
        <span class="logs-session-size">{formatBytes(props.sess.bytes)}</span>
        <span class="logs-session-exit" title={statusTitle()}>
          {statusLabel()}
        </span>
      </button>
      <button
        type="button"
        class="logs-session-reveal"
        title="Reveal in file manager"
        aria-label="Reveal in file manager"
        onClick={() => props.onReveal(props.sess.path)}
      >
        ⤷
      </button>
    </li>
  );
}
