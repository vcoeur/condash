// Reactive session controller behind the per-column voice controls — the
// lifecycle logic, kept out of the JSX so it can be regression-tested the way
// controller.ts is (real factory, faked edges).
//
// The contract it owns: there is NO state in which the microphone is
// capturing without the controls that can stop it. A recording therefore
// cannot outlive the controls' visibility — when the active tab goes away
// (column switch, Dashboard band, tab close) capture is cancelled and every
// track released in the same flush that hides the buttons, and disposal
// (column unmount, conception switch) cancels capture and playback too.
//
// Streaming (design note 04): the same recording state machine drives the
// realtime stream when main accepts the stream start — chunks flow through
// the recorder's per-chunk tap, accumulated partials ride back via
// `onVoicePartial` and surface on `partial()` for the live-caption strip.
// Streaming is an upgrade, never a requirement: every refusal or failure
// leaves the buffered-clip batch chain as the commit path, and the mic is
// ALWAYS released before the commit is awaited (the pre-existing guarantee).

import { createEffect, createSignal, onCleanup } from 'solid-js';
import type {
  VoiceAudioClip,
  VoicePartialMessage,
  VoiceSpeakResult,
  VoiceTranscribeResult,
} from '@shared/types';
import { micErrorMessage } from './voice-recorder';
import type { VoiceRecorder } from './voice-recorder';

/** The surface of HTMLAudioElement the session touches. `onended` reuses the
 *  element's own handler type so the real element satisfies it structurally
 *  while tests can assign a plain zero-arg callback. */
export interface AudioLike {
  pause(): void;
  play(): Promise<void>;
  onended: HTMLAudioElement['onended'];
}

/** The realtime-stream edge the session talks to — the typed IPC surface,
 *  injected so tests fake it. Optional: when absent the session behaves
 *  exactly like the batch-only v4.131 controller. */
export interface VoiceStreamEdge {
  start(sid: string): Promise<{ ok: boolean; reason?: string; error?: string }>;
  audio(chunk: { pcmBase64: string }): Promise<void>;
  stop(): Promise<VoiceTranscribeResult>;
  cancel(): Promise<void>;
  onPartial(callback: (msg: VoicePartialMessage) => void): () => void;
}

export interface VoiceSessionDeps {
  /** The column's active session id, or null when no tab can receive an
   *  insert. Reactively read: nulling it mid-recording cancels capture. */
  activeSid: () => string | null;
  onNotice: (message: string) => void;
  recorder: VoiceRecorder;
  transcribe(sid: string, clip: VoiceAudioClip): Promise<VoiceTranscribeResult>;
  speak(sid: string): Promise<VoiceSpeakResult>;
  createAudio(src: string): AudioLike;
  /** Realtime stream edge. Absent → batch-only behaviour. */
  stream?: VoiceStreamEdge;
}

export interface VoiceSession {
  readonly recording: () => boolean;
  readonly transcribing: () => boolean;
  readonly speaking: () => boolean;
  readonly busy: () => boolean;
  /** Accumulated realtime partial for the live-caption strip, or null when
   *  no stream is active. Never written to the PTY. */
  readonly partial: () => string | null;
  startDictation(): Promise<void>;
  stopDictation(): Promise<void>;
  toggleDictation(): Promise<void>;
  readAloud(): Promise<void>;
}

/** One shared playback element across every pane: starting a read stops the
 *  previous one. */
let currentAudio: AudioLike | null = null;

function stopPlayback(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

export function createVoiceSession(deps: VoiceSessionDeps): VoiceSession {
  const [recording, setRecording] = createSignal(false);
  const [transcribing, setTranscribing] = createSignal(false);
  const [speaking, setSpeaking] = createSignal(false);
  const [partial, setPartial] = createSignal<string | null>(null);
  const busy = (): boolean => transcribing() || speaking();

  /** The tab the clip belongs to, captured at record start — a mid-recording
   *  tab switch must not retarget the insert. */
  let targetSid: string | null = null;
  /** True while main holds an open realtime socket for this recording. */
  let streamActive = false;

  const cancelRecording = (): void => {
    if (streamActive && deps.stream) {
      streamActive = false;
      void deps.stream.cancel();
    }
    deps.recorder.cancel();
    setPartial(null);
    setRecording(false);
    targetSid = null;
  };

  // The controls render only while activeSid is set, so capture must not
  // outlive it: nulling activeSid releases the mic in the same reactive
  // flush that hides the buttons.
  createEffect(() => {
    if (deps.activeSid() === null && recording()) {
      cancelRecording();
      deps.onNotice('Recording cancelled — the tab is no longer active.');
    }
  });

  // Disposal can land while start() is still pending (mic prompt up); the
  // post-start guard below must then cancel even though activeSid still
  // holds, or the mic opens after cleanup with no controls left to stop it.
  let disposed = false;

  // Column unmount / conception switch: same release contract, plus playback.
  onCleanup(() => {
    disposed = true;
    cancelRecording();
    stopPlayback();
  });

  // Live partials for the caption strip: only the recording's own session
  // updates the signal, and the subscription dies with the controls.
  if (deps.stream) {
    const unsubscribe = deps.stream.onPartial((msg) => {
      if (streamActive && msg.sid === targetSid) setPartial(msg.text);
    });
    onCleanup(unsubscribe);
  }

  /**
   * Map a commit result to its notice. Returns true when the result is
   * final (noticed, nothing more to do); false when the caller should fall
   * through to the batch chain — for a stream stop, `no-session` means the
   * stream had already died, which is exactly the buffered-clip fallback
   * case (§9.3).
   */
  const noticeResult = (result: VoiceTranscribeResult, fallbackOnNoSession: boolean): boolean => {
    if (result.inserted) {
      deps.onNotice(`Dictated ${result.chars} characters into the tab.`);
      return true;
    }
    if (result.reason === 'empty-transcript') {
      deps.onNotice('Heard nothing usable — nothing was typed.');
      return true;
    }
    if (result.reason === 'no-session') {
      if (fallbackOnNoSession) return false;
      deps.onNotice('That tab is gone — nothing was typed.');
      return true;
    }
    if (result.reason === 'disabled') {
      // Stale-controls defence: the feature was switched off while a
      // recording was still in flight. Main already refused the clip.
      deps.onNotice('Voice is disabled — enable it in Settings → Voice.');
      return true;
    }
    return false;
  };

  const startDictation = async (): Promise<void> => {
    if (recording()) return;
    const sid = deps.activeSid();
    try {
      stopPlayback();
      await deps.recorder.start();
      // The tab can go away while the mic prompt or graph setup was pending —
      // start() resolves after the effect above could see a recording, so
      // re-check before declaring one. After disposal no toast: the pane is
      // gone, and a cancelled notice would only confuse.
      if (disposed || sid === null || deps.activeSid() === null) {
        cancelRecording();
        if (!disposed) {
          deps.onNotice('Recording cancelled — the tab is no longer active.');
        }
        return;
      }
      targetSid = sid;
      setRecording(true);
      // Stream upgrade: ask main to open the realtime socket. Every refusal
      // is silent — the buffered-clip batch chain stays the commit path and
      // the recording continues unchanged (§9.1).
      if (deps.stream) {
        const started = await deps.stream.start(sid);
        if (started.ok && !disposed && deps.activeSid() !== null && recording()) {
          streamActive = true;
          setPartial('');
        }
      }
    } catch (err) {
      deps.onNotice(micErrorMessage(err));
    }
  };

  const stopDictation = async (): Promise<void> => {
    if (!recording()) return;
    const sid = targetSid;
    setRecording(false);
    setTranscribing(true);
    const wasStreaming = streamActive;
    streamActive = false;
    try {
      // Mic released FIRST — the commit, streaming or batch, never keeps the
      // microphone open.
      const clip = await deps.recorder.stop();
      targetSid = null;
      if (wasStreaming && deps.stream) {
        setPartial(null);
        try {
          const result = await deps.stream.stop();
          if (noticeResult(result, true)) return;
        } catch {
          // Transport-level failure — the buffered clip is the fallback.
        }
      }
      if (!clip) {
        deps.onNotice('No speech captured.');
        return;
      }
      if (!sid) {
        deps.onNotice('The tab closed while recording — nothing was inserted.');
        return;
      }
      const result: VoiceTranscribeResult = await deps.transcribe(sid, clip);
      noticeResult(result, false);
    } catch (err) {
      deps.onNotice((err as Error).message);
    } finally {
      setTranscribing(false);
    }
  };

  const toggleDictation = async (): Promise<void> => {
    if (recording()) {
      await stopDictation();
      return;
    }
    await startDictation();
  };

  const readAloud = async (): Promise<void> => {
    const sid = deps.activeSid();
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
      const result: VoiceSpeakResult = await deps.speak(sid);
      if (!result.ok || !result.audioBase64) {
        deps.onNotice(result.error ?? 'Read-aloud failed.');
        return;
      }
      const audio = deps.createAudio(
        `data:${result.mime ?? 'audio/mpeg'};base64,${result.audioBase64}`,
      );
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
      deps.onNotice(`Read-aloud failed: ${(err as Error).message}`);
    }
  };

  return {
    recording,
    transcribing,
    speaking,
    busy,
    partial,
    startDictation,
    stopDictation,
    toggleDictation,
    readAloud,
  };
}
