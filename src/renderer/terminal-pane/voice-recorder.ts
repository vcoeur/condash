// Push-to-talk recorder: getUserMedia → AudioContext → PCM chunks.
//
// One instance drives one recording. The mic permission prompt fires only on
// the first `start()` (the main-process permission handler grants `media` to
// the app's own window contents); every `stop()`/`cancel()` stops ALL tracks
// and closes the AudioContext so the mic indicator never lingers. Nothing
// records unless the control toggled recording on.
//
// Capture is raw PCM via a ScriptProcessorNode rather than MediaRecorder:
// the clip must ship as WAV (both provider paths accept it; webm/opus is not
// in OpenRouter's documented audio-format list), and WAV avoids a decode
// dependency entirely. For seconds-long push-to-talk clips the main-thread
// callback cost is negligible.

import {
  bytesToBase64,
  encodeWav,
  float32ToInt16,
  RECORD_SAMPLE_RATE,
} from '@shared/voice-capture';
import type { VoiceAudioClip } from '@shared/types';

/** A clip shorter than ~250 ms carries no usable speech — treat it as an
 *  accidental double-click and report an empty clip. Compared against a
 *  duration so the gate stays honest when the backend ignores the requested
 *  rate (samples are counted at `capturedRate`, not RECORD_SAMPLE_RATE). */
const MIN_CLIP_MS = 250;

const BUFFER_SIZE = 4096;

export class MicUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicUnavailableError';
  }
}

/** Map a getUserMedia rejection to a user-actionable sentence. */
export function micErrorMessage(err: unknown): string {
  if (err instanceof MicUnavailableError) return err.message;
  const name = err instanceof Error && err.name ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied — allow the mic for condash and try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone found on this machine.';
  }
  if (name === 'NotReadableError') {
    return 'The microphone is in use by another application.';
  }
  return 'Could not open the microphone.';
}

export interface VoiceRecorder {
  /** Open the mic and start collecting samples. Throws MicUnavailableError
   *  (or a getUserMedia failure — see micErrorMessage) when the mic cannot
   *  be opened. */
  start(): Promise<void>;
  /** Stop capture and resolve to the recorded clip, or null when the clip
   *  is too short to carry speech. Always releases the mic. */
  stop(): Promise<VoiceAudioClip | null>;
  /** Abort without producing a clip. Always releases the mic. */
  cancel(): void;
  /** True between a resolved start() and stop()/cancel(). */
  readonly recording: boolean;
}

export function createVoiceRecorder(): VoiceRecorder {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let sink: GainNode | null = null;
  let chunks: Float32Array[] = [];
  let sampleCount = 0;
  let capturedRate = RECORD_SAMPLE_RATE;
  let active = false;

  function release(): void {
    try {
      processor?.disconnect();
      source?.disconnect();
      sink?.disconnect();
    } catch {
      /* nodes may already be torn down with the context */
    }
    processor = null;
    source = null;
    sink = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    void context?.close().catch(() => undefined);
    context = null;
    active = false;
  }

  return {
    get recording(): boolean {
      return active;
    },

    async start(): Promise<void> {
      if (active) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new MicUnavailableError('This environment offers no microphone capture.');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Echo cancellation keeps dictation out of any speaker loopback;
          // the brief calls for it explicitly.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      context = new AudioContext({ sampleRate: RECORD_SAMPLE_RATE });
      // Some backends ignore the requested rate — the WAV header must carry
      // the truth or players transcode wrong.
      capturedRate = context.sampleRate;
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
      chunks = [];
      sampleCount = 0;
      processor.onaudioprocess = (event) => {
        if (!active) return;
        const input = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
        sampleCount += input.length;
      };
      sink = context.createGain();
      sink.gain.value = 0; // silent sink: keeps the graph pumping without audio out
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
      active = true;
    },

    async stop(): Promise<VoiceAudioClip | null> {
      if (!active) return null;
      const rate = capturedRate;
      const collected = chunks;
      const samples = sampleCount;
      release();
      chunks = [];
      sampleCount = 0;
      if (samples < (rate * MIN_CLIP_MS) / 1000) return null;
      const merged = new Float32Array(samples);
      let offset = 0;
      for (const chunk of collected) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const wav = encodeWav(float32ToInt16(merged), rate);
      return { data: bytesToBase64(wav), sampleRate: rate, format: 'wav' };
    },

    cancel(): void {
      release();
      chunks = [];
      sampleCount = 0;
    },
  };
}
