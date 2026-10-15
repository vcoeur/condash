// The voice controls in a terminal column's header: a Dictate toggle
// (click to start, click again to transcribe-and-insert; hold the
// push-to-talk chord for the same without the mouse) and a Read-aloud
// button (on-demand TTS of the tab's recent output — never automatic). Both
// act on the column's active tab.
//
// With streaming accepted by main, the recording rides the realtime socket:
// chunks flow through the recorder's per-chunk tap and the accumulated
// partial is pushed up to the column's live-caption strip via `onPartial`.
// A stream refusal or failure changes nothing visible here — the buffered
// clip batch chain commits on stop exactly as before.
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

import { createEffect, onCleanup, onMount, Show } from 'solid-js';
import { createVoiceRecorder } from '../voice-recorder';
import { createVoiceSession } from '../voice-session';
import { registerVoicePtt } from '../voice-ptt-registry';

export interface VoiceControlsProps {
  /** The column's active session id, or null when none is live. Both
   *  controls disable without one, and nulling it mid-recording cancels the
   *  recording. */
  activeSid: string | null;
  /** Surface a notice (insert result, empty transcript, errors) to the app
   *  toast. */
  onNotice: (message: string) => void;
  /** Live-caption feed: the accumulated streaming partial, or null when no
   *  stream is live. The column renders it under the tab row. */
  onPartial?: (text: string | null) => void;
  /** True when this column is the app's active terminal column — the
   *  push-to-talk chord starts dictation here. */
  isActiveColumn?: boolean;
}

export function VoiceControls(props: VoiceControlsProps) {
  const recorder = createVoiceRecorder({
    // Realtime tap: while the recording is live — not only once a partial
    // exists — so chunks captured during the stream-start round-trip (the
    // utterance's leading edge) reach the stream and the bias repass too.
    // A refused or dead stream no-ops in main; fire-and-forget either way:
    // a dropped chunk only thins the partial view, the buffered clip keeps
    // everything.
    onChunk: (ownerId, pcmBase64) => session.handleAudio(ownerId, pcmBase64),
  });
  const session = createVoiceSession({
    activeSid: () => props.activeSid,
    onNotice: props.onNotice,
    recorder,
    stream: {
      // The start labels the session with the rate the mic actually
      // captured at, so main's reassembled repass WAV header is honest
      // (same semantics as the recorder's own clip).
      start: (sid, ownerId) =>
        window.condash.voiceStreamStart({ sid, ownerId, sampleRate: recorder.capturedRate }),
      audio: (chunk) => window.condash.voiceStreamAudio(chunk),
      stop: (ownerId) => window.condash.voiceStreamStop(ownerId),
      cancel: (ownerId) => window.condash.voiceStreamCancel(ownerId),
      onPartial: (callback) => window.condash.onVoicePartial(callback),
    },
    transcribe: (sid, clip) => window.condash.voiceTranscribe(sid, clip),
    speak: (sid) => window.condash.voiceSpeak(sid),
    createAudio: (src) => new Audio(src),
  });

  createEffect(() => props.onPartial?.(session.partial()));

  // Push-to-talk: register this column with the global registry for the
  // lifetime of the controls. The chord only engages when this is the active
  // column with a live tab — pressing it over the Dashboard band must not
  // flash the microphone.
  onMount(() => {
    const unregister = registerVoicePtt({
      isActiveColumn: () => props.isActiveColumn === true && props.activeSid !== null,
      isRecording: () => session.capturing(),
      acquire: session.acquireDictation,
    });
    onCleanup(unregister);
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
        disabled={session.capturing() || session.transcribing()}
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
