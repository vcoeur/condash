// The voice controls in a terminal column's header: a Dictate toggle
// (push-to-talk MVP — click to start, click again to transcribe-and-insert)
// and a Read-aloud button (on-demand TTS of the tab's recent output — never
// automatic). Both act on the column's active tab.
//
// The column gates mounting this component on `voice.enabled` (Settings →
// Voice, default off): with the feature off the controls never render, and
// switching it off mid-recording unmounts them — which is what triggers the
// same-flush mic release described below.
//
// All lifecycle logic (mic release on activeSid nulling / disposal, playback
// stop, insert-target capture) lives in the session controller next door
// (../voice-session.ts) and is regression-tested there; this file only binds
// it to buttons.

import { Show } from 'solid-js';
import { createVoiceRecorder } from '../voice-recorder';
import { createVoiceSession } from '../voice-session';

export interface VoiceControlsProps {
  /** The column's active session id, or null when none is live. Both
   *  controls disable without one, and nulling it mid-recording cancels the
   *  recording. */
  activeSid: string | null;
  /** Surface a notice (insert result, empty transcript, errors) to the app
   *  toast. */
  onNotice: (message: string) => void;
}

export function VoiceControls(props: VoiceControlsProps) {
  const session = createVoiceSession({
    activeSid: () => props.activeSid,
    onNotice: props.onNotice,
    recorder: createVoiceRecorder(),
    transcribe: (sid, clip) => window.condash.voiceTranscribe(sid, clip),
    speak: (sid) => window.condash.voiceSpeak(sid),
    createAudio: (src) => new Audio(src),
  });

  return (
    <Show when={props.activeSid}>
      <button
        type="button"
        class="terminal-header-action voice-dictate"
        classList={{ recording: session.recording() }}
        data-label="dictate"
        disabled={session.busy()}
        aria-pressed={session.recording()}
        // Suppressing the pointerdown default keeps the click from moving
        // focus off the xterm textarea — dictation is spoken, but the user is
        // still typing in this tab and must not lose the caret to a control.
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          void session.toggleDictation();
        }}
        title={
          session.recording()
            ? 'Recording — click again to transcribe and type the text into this tab'
            : 'Dictate: record speech, then insert the transcript as typed input'
        }
      >
        <Show when={session.recording()} fallback={<span>Dictate</span>}>
          <span class="voice-record-dot" aria-hidden="true" />
          Recording
        </Show>
      </button>
      <button
        type="button"
        class="terminal-header-action"
        data-label="read-aloud"
        disabled={session.recording() || session.transcribing()}
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          void session.readAloud();
        }}
        title="Read this tab's recent output aloud (on-demand; sends the text to the TTS provider)"
      >
        {session.speaking() ? 'Stop' : 'Read'}
      </button>
    </Show>
  );
}
