// The voice controls in a terminal column's header: a Dictate toggle
// (push-to-talk MVP — click to start, click again to transcribe-and-insert)
// and a Read-aloud button (on-demand TTS of the tab's recent output — never
// automatic). Both act on the column's active tab.

import { createSignal, Show } from 'solid-js';
import type { VoiceSpeakResult, VoiceTranscribeResult } from '@shared/types';
import { createVoiceRecorder, micErrorMessage } from '../voice-recorder';
import type { VoiceRecorder } from '../voice-recorder';

/** One shared playback element: starting a read stops the previous one. */
let currentAudio: HTMLAudioElement | null = null;

function stopPlayback(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

export interface VoiceControlsProps {
  /** The column's active session id, or null when none is live. Both
   *  controls disable without one. */
  activeSid: string | null;
  /** Surface a notice (insert result, empty transcript, errors) to the app
   *  toast. */
  onNotice: (message: string) => void;
}

export function VoiceControls(props: VoiceControlsProps) {
  const recorder: VoiceRecorder = createVoiceRecorder();
  const [recording, setRecording] = createSignal(false);
  const [transcribing, setTranscribing] = createSignal(false);
  const [speaking, setSpeaking] = createSignal(false);

  const busy = (): boolean => transcribing() || speaking();

  const toggleDictation = async (): Promise<void> => {
    if (recording()) {
      setRecording(false);
      setTranscribing(true);
      try {
        const clip = await recorder.stop();
        if (!clip) {
          props.onNotice('No speech captured.');
          return;
        }
        const sid = props.activeSid;
        if (!sid) {
          props.onNotice('The tab closed while recording — nothing was inserted.');
          return;
        }
        const result: VoiceTranscribeResult = await window.condash.voiceTranscribe(sid, clip);
        if (result.inserted) {
          props.onNotice(`Dictated ${result.chars} characters into the tab.`);
        } else if (result.reason === 'empty-transcript') {
          props.onNotice('Heard nothing usable — nothing was typed.');
        } else if (result.reason === 'no-session') {
          props.onNotice('That tab is gone — nothing was typed.');
        }
      } catch (err) {
        props.onNotice((err as Error).message);
      } finally {
        setTranscribing(false);
      }
      return;
    }
    try {
      stopPlayback();
      await recorder.start();
      setRecording(true);
    } catch (err) {
      props.onNotice(micErrorMessage(err));
    }
  };

  const readAloud = async (): Promise<void> => {
    const sid = props.activeSid;
    if (!sid) return;
    if (speaking()) {
      stopPlayback();
      setSpeaking(false);
      return;
    }
    // Recording and reading at once would interleave the mic with speaker
    // output even with echo cancellation — finish one first.
    if (recording()) return;
    setSpeaking(true);
    try {
      stopPlayback();
      const result: VoiceSpeakResult = await window.condash.voiceSpeak(sid);
      if (!result.ok || !result.audioBase64) {
        props.onNotice(result.error ?? 'Read-aloud failed.');
        return;
      }
      const audio = new Audio(`data:${result.mime ?? 'audio/mpeg'};base64,${result.audioBase64}`);
      currentAudio = audio;
      audio.onended = () => {
        if (currentAudio === audio) {
          currentAudio = null;
          setSpeaking(false);
        }
      };
      await audio.play();
    } catch (err) {
      setSpeaking(false);
      props.onNotice(`Read-aloud failed: ${(err as Error).message}`);
    }
  };

  return (
    <Show when={props.activeSid}>
      <button
        type="button"
        class="terminal-header-action voice-dictate"
        classList={{ recording: recording() }}
        data-label="dictate"
        disabled={busy()}
        aria-pressed={recording()}
        onClick={(e) => {
          e.stopPropagation();
          void toggleDictation();
        }}
        title={
          recording()
            ? 'Recording — click again to transcribe and type the text into this tab'
            : 'Dictate: record speech, then insert the transcript as typed input'
        }
      >
        <Show when={recording()} fallback={<span>Dictate</span>}>
          <span class="voice-record-dot" aria-hidden="true" />
          Recording
        </Show>
      </button>
      <button
        type="button"
        class="terminal-header-action"
        data-label="read-aloud"
        disabled={recording() || transcribing()}
        onClick={(e) => {
          e.stopPropagation();
          void readAloud();
        }}
        title="Read this tab's recent output aloud (on-demand; sends the text to the TTS provider)"
      >
        {speaking() ? 'Stop' : 'Read'}
      </button>
    </Show>
  );
}
