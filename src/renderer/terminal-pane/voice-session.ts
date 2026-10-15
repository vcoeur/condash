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
// Refused/failed startup retains the buffered batch path; an ambiguous stop
// rejection is not retried because main may already have inserted. The mic is
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
  start(sid: string, ownerId: string): Promise<{ ok: boolean; reason?: string; error?: string }>;
  audio(chunk: { ownerId: string; pcmBase64: string }): Promise<void>;
  stop(ownerId: string): Promise<VoiceTranscribeResult>;
  cancel(ownerId: string): Promise<void>;
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

export interface VoiceDictationLease {
  release(): void;
  cancel(): void;
}

export interface VoiceSession {
  readonly recording: () => boolean;
  readonly capturing: () => boolean;
  readonly transcribing: () => boolean;
  readonly speaking: () => boolean;
  readonly busy: () => boolean;
  /** Accumulated realtime partial for the live-caption strip, or null when
   *  no stream is active. Never written to the PTY. */
  readonly partial: () => string | null;
  startDictation(): Promise<void>;
  stopDictation(): Promise<void>;
  toggleDictation(): Promise<void>;
  acquireDictation(): VoiceDictationLease | null;
  readAloud(): Promise<void>;
  handleAudio(ownerId: string, pcmBase64: string): void;
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
  const [capturing, setCapturing] = createSignal(false);
  const busy = (): boolean => transcribing() || speaking();

  interface Attempt {
    ownerId: string;
    sid: string;
    phase: 'microphone' | 'capture' | 'stopped' | 'cancelled';
    stream: 'none' | 'pending' | 'ready' | 'batch';
    cancellation?: Promise<void>;
  }
  let current: Attempt | null = null;
  let latest: Attempt | null = null;
  let disposed = false;
  const owns = (attempt: Attempt): boolean => !disposed && current === attempt;
  const visible = (attempt: Attempt): boolean => !disposed && latest === attempt;
  const cancelStream = (attempt: Attempt): void => {
    if (
      attempt.cancellation ||
      !deps.stream ||
      (attempt.stream !== 'pending' && attempt.stream !== 'ready')
    )
      return;
    const stream = deps.stream;
    let requested: Promise<void>;
    try {
      requested = stream.cancel(attempt.ownerId);
    } catch (error) {
      requested = Promise.reject(error);
    }
    // One authority per utterance, including late start replies. Main retains
    // bounded completed-owner evidence, so one retry is safe on ambiguous failure.
    attempt.cancellation = requested
      .catch(() => stream.cancel(attempt.ownerId))
      .catch(() => {
        if (visible(attempt))
          deps.onNotice(
            'Could not confirm streaming cancellation — restart the application before dictating again.',
          );
      });
  };

  const cancelRecording = (attempt = current): void => {
    if (!attempt || current !== attempt) return;
    attempt.phase = 'cancelled';
    current = null;
    deps.recorder.cancel(attempt.ownerId);
    cancelStream(attempt);
    setPartial(null);
    setRecording(false);
    setCapturing(false);
  };

  // The controls render only while activeSid is set, so capture must not
  // outlive it: nulling activeSid releases the mic in the same reactive
  // flush that hides the buttons.
  createEffect(() => {
    if (deps.activeSid() === null && capturing()) {
      cancelRecording();
      deps.onNotice('Recording cancelled — the tab is no longer active.');
    }
  });

  // Disposal can land while start() is still pending (mic prompt up); the
  // post-start guard below must then cancel even though activeSid still
  // holds, or the mic opens after cleanup with no controls left to stop it.

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
      if (current?.stream === 'ready' && msg.sid === current.sid && msg.ownerId === current.ownerId)
        setPartial(msg.text);
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
    if (disposed || current || speaking()) return;
    const sid = deps.activeSid();
    if (sid === null) return;
    const attempt: Attempt = {
      ownerId: crypto.randomUUID(),
      sid,
      phase: 'microphone',
      stream: 'none',
    };
    current = latest = attempt;
    setCapturing(true);
    setTranscribing(false);
    try {
      stopPlayback();
      await deps.recorder.start(attempt.ownerId);
      // The tab can go away while the mic prompt or graph setup was pending —
      // start() resolves after the effect above could see a recording, so
      // re-check before declaring one. After disposal no toast: the pane is
      // gone, and a cancelled notice would only confuse.
      if (!owns(attempt)) return;
      attempt.phase = 'capture';
      setRecording(true);
      // Stream upgrade: ask main to open the realtime socket. Every refusal
      // is silent — the buffered-clip batch chain stays the commit path and
      // the recording continues unchanged (§9.1).
      if (deps.stream) {
        attempt.stream = 'pending';
        try {
          const started = await deps.stream.start(sid, attempt.ownerId);
          if (!owns(attempt)) {
            if (started.ok) cancelStream(attempt);
            return;
          }
          attempt.stream = started.ok ? 'ready' : 'batch';
          if (started.ok) {
            setPartial('');
          }
        } catch {
          // A stream-start IPC rejection is not a microphone failure — the
          // mic is already open and the recording continues on the batch
          // chain, so the notice must say that, not "could not open the
          // microphone" (the outer catch is for recorder.start() errors).
          if (owns(attempt)) {
            cancelStream(attempt);
            attempt.stream = 'batch';
            deps.onNotice('Streaming unavailable — using batch transcription.');
          }
        }
      }
    } catch (err) {
      if (owns(attempt)) {
        cancelRecording();
        deps.onNotice(micErrorMessage(err));
      }
    }
  };

  const stopDictation = async (attempt = current): Promise<void> => {
    if (!attempt || !owns(attempt)) return;
    if (attempt.phase === 'microphone') {
      cancelRecording();
      return;
    }
    const sid = attempt.sid;
    const wasStreaming = attempt.stream === 'ready';
    attempt.phase = 'stopped';
    current = null;
    setRecording(false);
    setCapturing(false);
    setPartial(null);
    setTranscribing(true);
    try {
      // Mic released FIRST — the commit, streaming or batch, never keeps the
      // microphone open.
      const stopping = deps.recorder.stop(attempt.ownerId);
      if (attempt.stream === 'pending') cancelStream(attempt);
      const clip = await stopping;
      if (wasStreaming && deps.stream) {
        // A rejected stop may already have committed in main. Only an explicit
        // no-session response proves that the buffered fallback is safe.
        const result = await deps.stream.stop(attempt.ownerId);
        if (result.reason !== 'no-session') {
          if (visible(attempt)) noticeResult(result, false);
          return;
        }
      }
      if (!clip) {
        if (visible(attempt)) deps.onNotice('No speech captured.');
        return;
      }
      if (!sid) {
        deps.onNotice('The tab closed while recording — nothing was inserted.');
        return;
      }
      const result: VoiceTranscribeResult = await deps.transcribe(sid, clip);
      if (visible(attempt)) noticeResult(result, false);
    } catch (err) {
      if (visible(attempt)) deps.onNotice((err as Error).message);
    } finally {
      if (visible(attempt)) setTranscribing(false);
    }
  };

  const toggleDictation = async (): Promise<void> => {
    if (capturing()) {
      await stopDictation();
      return;
    }
    await startDictation();
  };

  const acquireDictation = (): VoiceDictationLease | null => {
    if (!current) void startDictation();
    const attempt = current;
    if (!attempt || disposed) return null;
    // A gesture can end only the attempt it acquired, never a later click restart.
    let consumed = false;
    const consume = (commit: boolean): void => {
      if (consumed) return;
      consumed = true;
      if (!owns(attempt)) return;
      if (commit) void stopDictation(attempt);
      else cancelRecording(attempt);
    };
    return { release: () => consume(true), cancel: () => consume(false) };
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
    if (capturing()) return;
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
    capturing,
    transcribing,
    speaking,
    busy,
    partial,
    startDictation,
    stopDictation,
    toggleDictation,
    acquireDictation,
    readAloud,
    handleAudio: (ownerId, pcmBase64) => {
      if (
        current?.ownerId === ownerId &&
        current.phase === 'capture' &&
        (current.stream === 'pending' || current.stream === 'ready')
      ) {
        void deps.stream?.audio({ ownerId, pcmBase64 }).catch(() => undefined);
      }
    },
  };
}
