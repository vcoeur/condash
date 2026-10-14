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
  start(ownerId: string): Promise<void>;
  /** Stop capture and resolve to the recorded clip, or null when the clip
   *  is too short to carry speech. Always releases the mic. */
  stop(ownerId: string): Promise<VoiceAudioClip | null>;
  /** Abort without producing a clip. Always releases the mic. */
  cancel(ownerId: string): void;
  /** True between a resolved start() and stop()/cancel(). */
  readonly recording: boolean;
  /** The rate the current (or last) capture ran at — the AudioContext's
   *  actual rate, which some backends vary from the requested 16 kHz. The
   *  realtime stream start labels its session with this so main's
   *  reassembled repass WAV carries an honest header. */
  readonly capturedRate: number;
}

export interface VoiceRecorderOptions {
  /** Per-chunk tap for the realtime stream: every captured buffer, base64
   *  s16le PCM (no WAV header), right after it joins the batch buffer. The
   *  batch fallback buffering below is untouched — the tap is an additive
   *  observer, so a stream that never consumes the chunks loses nothing. */
  onChunk?: (ownerId: string, pcmBase64: string) => void;
}

export function createVoiceRecorder(options: VoiceRecorderOptions = {}): VoiceRecorder {
  interface Capture {
    ownerId: string;
    cancelled: boolean;
    active: boolean;
    stream?: MediaStream;
    context?: AudioContext;
    processor?: ScriptProcessorNode;
    source?: MediaStreamAudioSourceNode;
    sink?: GainNode;
    chunks: Float32Array[];
    samples: number;
    rate: number;
  }
  let current: Capture | null = null;
  let capturedRate = RECORD_SAMPLE_RATE;

  function release(capture: Capture): void {
    capture.cancelled = true;
    capture.active = false;
    if (current === capture) current = null;
    if (capture.processor) capture.processor.onaudioprocess = null;
    for (const node of [capture.processor, capture.source, capture.sink]) {
      try {
        node?.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    capture.stream?.getTracks().forEach((track) => track.stop());
    capture.stream = undefined;
    void capture.context?.close().catch(() => undefined);
    capture.context = undefined;
  }

  return {
    get recording(): boolean {
      return current?.active === true;
    },

    get capturedRate(): number {
      return capturedRate;
    },

    async start(ownerId): Promise<void> {
      if (current) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new MicUnavailableError('This environment offers no microphone capture.');
      }
      const capture: Capture = {
        ownerId,
        cancelled: false,
        active: false,
        chunks: [],
        samples: 0,
        rate: RECORD_SAMPLE_RATE,
      };
      current = capture;
      try {
        capture.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // Echo cancellation keeps dictation out of any speaker loopback;
            // the brief calls for it explicitly.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        if (capture.cancelled || current !== capture) {
          release(capture);
          return;
        }
        const context = (capture.context = new AudioContext({ sampleRate: RECORD_SAMPLE_RATE }));
        // Some backends ignore the requested rate — the WAV header must carry
        // the truth or players transcode wrong.
        capturedRate = capture.rate = context.sampleRate;
        const source = (capture.source = context.createMediaStreamSource(capture.stream));
        const processor = (capture.processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1));
        processor.onaudioprocess = (event) => {
          if (!capture.active || capture.cancelled || current !== capture) return;
          const input = event.inputBuffer.getChannelData(0);
          capture.chunks.push(new Float32Array(input));
          capture.samples += input.length;
          if (options.onChunk) {
            const pcm = float32ToInt16(input);
            options.onChunk(
              ownerId,
              bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
            );
          }
        };
        const sink = (capture.sink = context.createGain());
        sink.gain.value = 0; // silent sink: keeps the graph pumping without audio out
        source.connect(processor);
        processor.connect(sink);
        sink.connect(context.destination);
        capture.active = true;
      } catch (error) {
        const cancelled = capture.cancelled;
        release(capture);
        if (!cancelled) throw error;
      }
    },

    async stop(ownerId): Promise<VoiceAudioClip | null> {
      const capture = current;
      if (!capture || capture.ownerId !== ownerId) return null;
      const { rate, chunks: collected, samples } = capture;
      release(capture);
      capture.chunks = [];
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

    cancel(ownerId): void {
      if (current?.ownerId !== ownerId) return;
      release(current);
    },
  };
}
