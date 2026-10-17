import type { VoiceAudioClip, VoiceTranscribeResult } from '../../shared/types';
import { encodeWav, RECORD_SAMPLE_RATE } from '../../shared/voice-capture';
import type { InsertOutcome } from './insert';
import type { TranscribeSuccess } from './adapter';

export const MAX_RECORDING_BYTES = 20_000_000;

export interface VoiceStreamSessionDeps {
  ownerId: string;
  sid: string;
  sampleRate?: number;
  previews?: boolean;
  transcribe(clip: VoiceAudioClip, signal: AbortSignal): Promise<TranscribeSuccess>;
  onPartial(text: string): void;
  onUnavailable?(reason: string): void;
  insert(sid: string, text: string): InsertOutcome;
}

export interface VoiceStreamSession {
  readonly ownerId: string;
  readonly sid: string;
  handleAudio(pcmBase64: string): void;
  stop(): Promise<VoiceTranscribeResult>;
  cancel(): void;
}

/** Non-overlapping previews plus one full final WAV: each sample uploads at
 * most twice. Pending preview audio coalesces, never grows beyond eight seconds. */
export class VoiceStreamSessionImpl implements VoiceStreamSession {
  readonly ownerId: string;
  readonly sid: string;
  private readonly rate: number;
  private pcm: Buffer[] = [];
  private bytes = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private preview: AbortController | null = null;
  private final: AbortController | null = null;
  private previewOff: boolean;
  private finished = false;
  private cancelled = false;
  private failure: string | null = null;
  private caption = '';

  constructor(private readonly deps: VoiceStreamSessionDeps) {
    this.ownerId = deps.ownerId;
    this.sid = deps.sid;
    this.rate = deps.sampleRate ?? RECORD_SAMPLE_RATE;
    if (!Number.isInteger(this.rate) || this.rate < 8000 || this.rate > 192000)
      throw new Error('Dictation requires an integer sample rate from 8000 to 192000 Hz.');
    this.previewOff = deps.previews === false;
  }

  handleAudio(pcmBase64: string): void {
    if (this.finished || this.failure) return;
    if (pcmBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(pcmBase64)) {
      this.failRecording('Malformed PCM audio — recording cannot be transcribed.');
      return;
    }
    const bytes = Buffer.from(pcmBase64, 'base64');
    if (!bytes.length || bytes.length % 2 || bytes.toString('base64') !== pcmBase64) {
      this.failRecording('Malformed PCM16 audio — recording cannot be transcribed.');
      return;
    }
    if (this.bytes + bytes.length + 44 > MAX_RECORDING_BYTES) {
      this.failRecording('Recording exceeds the 20 MB limit — nothing will be inserted.');
      return;
    }
    this.pcm.push(bytes);
    this.bytes += bytes.length;
    if (this.previewOff) return;
    if (this.pendingBytes + bytes.length > this.rate * 2 * 8) {
      this.disablePreviews(
        'OpenRouter captions fell behind the eight-second limit; final transcription follows Stop.',
      );
      return;
    }
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    this.pump();
  }

  private clip(parts: Buffer[], length: number): VoiceAudioClip {
    const merged = Buffer.concat(parts, length);
    const samples = new Int16Array(length / 2);
    for (let index = 0; index < samples.length; index++)
      samples[index] = merged.readInt16LE(index * 2);
    return {
      data: Buffer.from(encodeWav(samples, this.rate)).toString('base64'),
      sampleRate: this.rate,
      format: 'wav',
    };
  }

  private pump(): void {
    if (this.finished || this.previewOff || this.preview || this.pendingBytes < this.rate * 2 * 2)
      return;
    const clip = this.clip(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    const controller = (this.preview = new AbortController());
    void this.deps
      .transcribe(clip, controller.signal)
      .then((result) => {
        if (this.finished || this.previewOff || controller.signal.aborted) return;
        const text = result.text.trim();
        if (text) {
          this.caption = [this.caption, text].filter(Boolean).join(' ');
          this.deps.onPartial(this.caption);
        }
      })
      .catch((error: unknown) => {
        if (!this.finished && !controller.signal.aborted)
          this.disablePreviews(`OpenRouter captions unavailable: ${(error as Error).message}`);
      })
      .finally(() => {
        if (this.preview === controller) this.preview = null;
        this.pump();
      });
  }

  private disablePreviews(reason: string): void {
    if (this.previewOff) return;
    this.previewOff = true;
    this.preview?.abort();
    this.pending = [];
    this.pendingBytes = 0;
    this.deps.onUnavailable?.(reason);
  }

  private failRecording(reason: string): void {
    this.failure = reason;
    this.disablePreviews(reason);
    this.pcm = [];
    this.bytes = 0;
  }

  async stop(): Promise<VoiceTranscribeResult> {
    if (this.finished) return { inserted: false, reason: 'no-session' };
    this.finished = true;
    this.preview?.abort();
    this.pending = [];
    this.pendingBytes = 0;
    if (this.failure) return { inserted: false, reason: 'error', error: this.failure };
    if (!this.bytes) return { inserted: false, reason: 'empty-transcript' };
    const controller = (this.final = new AbortController());
    const clip = this.clip(this.pcm, this.bytes);
    this.pcm = [];
    this.bytes = 0;
    try {
      const transcript = await this.deps.transcribe(clip, controller.signal);
      if (this.cancelled) return { inserted: false, reason: 'no-session' };
      const outcome = this.deps.insert(this.sid, transcript.text);
      return outcome.inserted
        ? {
            inserted: true,
            chars: outcome.chars,
            provider: transcript.provider,
            producer: transcript.producer,
          }
        : { inserted: false, reason: outcome.reason, producer: transcript.producer };
    } catch (error) {
      if (this.cancelled) return { inserted: false, reason: 'no-session' };
      return { inserted: false, reason: 'error', error: (error as Error).message };
    } finally {
      this.final = null;
    }
  }

  cancel(): void {
    this.cancelled = this.finished = true;
    this.preview?.abort();
    this.final?.abort();
    this.pcm = this.pending = [];
    this.bytes = this.pendingBytes = 0;
  }
}
