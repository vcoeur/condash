// Realtime dictation stream (design note 04 §3): one WebSocket session in
// main against Mistral's realtime transcription endpoint, fed by the
// renderer's per-chunk mic tap over typed IPC.
//
// Wire contract — every fact below verified live against
// `wss://api.mistral.ai/v1/audio/transcriptions/realtime` on 2026-10-12
// (probes in the project notes, note 05):
//   - the upgrade accepts an `Authorization: Bearer <key>` header (the key
//     never leaves main);
//   - the first server frame is `{"type":"session.created", session:{…}}`;
//   - `{"type":"session.update","session":{"target_streaming_delay_ms":N}}`
//     is answered by `session.updated` echoing the value (the documented
//     `targetStreamingDelayMs` knob, raw-WS form);
//   - audio goes out as RAW BINARY frames of pcm_s16le mono samples — the
//     server accounted `usage.prompt_audio_seconds` for exactly the bytes
//     sent;
//   - `{"type":"input_audio.end"}` finishes the utterance; the server
//     answers `{"type":"transcription.done", text, usage, …}`;
//   - partial text rides `{"type":"transcription.text.delta", text}` events;
//   - failures surface as `{"type":"error","error":{"message"}}` frames.
//
// The session owns the single-active-stream invariant, the accumulated
// partial text, and the stop-time commit: sanitised text through the
// unchanged `insertTranscript` path, exactly once. Partials NEVER reach the
// PTY. On stop with a non-empty effective bias list the commit is routed
// through a bias-corrected batch repass first (§8), using the PCM this
// session already received — reassembled as the same WAV the batch chain
// accepts — with the realtime text as the last-resort fallback.

import WebSocket from 'ws';
import type {
  VoicePrefs,
  VoiceProvider,
  VoiceTranscribeResult,
  VoiceTranscriptProducer,
} from '../../shared/types';
import { encodeWav, RECORD_SAMPLE_RATE } from '../../shared/voice-capture';
import type { InsertOutcome } from './insert';
import type { ResolvedVoiceKeys } from './keys';
import type { TranscribeSuccess } from './adapter';

/** The realtime transcription model — a query parameter on the upgrade. */
export const REALTIME_MODEL = 'voxtral-mini-transcribe-realtime-2602';
export const REALTIME_WS_URL = `wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=${REALTIME_MODEL}`;

/** Hardcoded v1 latency/accuracy knob (design §4 — the docs' accuracy-leaning
 *  value; settable via `session.update`, verified live). Not a settings key. */
export const TARGET_STREAMING_DELAY_MS = 1000;

/** Bounded wait on stop for the provider's final text. */
export const FINALISE_TIMEOUT_MS = 5000;
/** Bounded wait for the socket upgrade at start. */
export const CONNECT_TIMEOUT_MS = 5000;

/** Cap on the PCM this session accumulates for the bias repass — the same
 *  ~20 MB (~10 min of 16 kHz mono) bound as the upload path; past it,
 *  further audio still streams but is no longer retained. */
const MAX_PCM_BYTES = 20_000_000;

/** The surface of the `ws` WebSocket this module touches — injectable so the
 *  unit tests run without a network. */
export interface RealtimeSocket {
  send(data: string | Buffer, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
}

export type RealtimeSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => RealtimeSocket;

/** Default factory: the pure-JS `ws` client (bundled; no native rebuild). */
export function createRealtimeSocket(url: string, headers: Record<string, string>): RealtimeSocket {
  return new WebSocket(url, { headers }) as unknown as RealtimeSocket;
}

/** The two batch chains, pre-bound by the IPC layer with keys/prefs/bias —
 *  the session only decides *whether* to call them and with which clip. */
export interface BatchTranscribers {
  normal(clip: VoiceAudioClipLike): Promise<TranscribeSuccess>;
  biasFirst(clip: VoiceAudioClipLike): Promise<TranscribeSuccess>;
}

/** Structural clip shape (`VoiceAudioClip`) so the tests need no literal. */
export interface VoiceAudioClipLike {
  data: string;
  sampleRate: number;
  format: 'wav';
}

export interface VoiceStreamSessionDeps {
  ownerId: string;
  sid: string;
  /** The rate the renderer's mic actually captured at (Hz) — the reassembled
   *  repass clip labels its WAV header with this instead of assuming the
   *  requested 16 kHz, mirroring the recorder's `capturedRate` semantics.
   *  Unset → RECORD_SAMPLE_RATE. */
  sampleRate?: number;
  apiKey: string;
  /** Resolved effective bias list (user phrases + app handles). Non-empty
   *  routes the stop commit through `batchTranscribers.biasFirst` (§8). */
  contextBias: string[];
  keys: ResolvedVoiceKeys;
  prefs?: VoicePrefs;
  createSocket: RealtimeSocketFactory;
  /** Push the accumulated partial text (already the whole text so far). */
  onPartial: (text: string) => void;
  onUnavailable?: () => void;
  /** The unchanged PTY-insert path (sanitise + liveness + single write). */
  insert(sid: string, text: string): InsertOutcome;
  batchTranscribers: BatchTranscribers;
  connectTimeoutMs?: number;
  finaliseTimeoutMs?: number;
}

export interface VoiceStreamSession {
  readonly ownerId: string;
  readonly sid: string;
  /** Forward one base64 PCM chunk to the socket (buffered until open). */
  handleAudio(pcmBase64: string): void;
  /** Finalise + commit exactly once. Takes the session out of the active
   *  slot; safe to call only through `takeActiveVoiceStream`. */
  stop(): Promise<VoiceTranscribeResult>;
  /** Abort: close the socket, commit nothing. */
  cancel(): void;
}

const enum SocketState {
  Connecting,
  Open,
  Finalising,
  Closed,
}

class VoiceStreamSessionImpl implements VoiceStreamSession {
  readonly ownerId: string;
  readonly sid: string;

  private readonly socket: RealtimeSocket;
  private state = SocketState.Connecting;
  private accumulated = '';
  private finalText: string | null = null;
  private failed: string | null = null;
  private pcm: Buffer[] = [];
  private pcmBytes = 0;
  private pending: Buffer[] = [];
  private finished = false;
  private committed = false;
  private cancelled = false;
  private rejectOpen: ((message: string) => void) | null = null;
  private finaliseWaiters: (() => void)[] = [];

  /** Resolves once the socket is open (or rejects on error/close/timeout) —
   *  `beginVoiceStream` answers its typed refusal from this. */
  readonly opened: Promise<void>;

  constructor(private readonly deps: VoiceStreamSessionDeps) {
    this.sid = deps.sid;
    this.ownerId = deps.ownerId;
    this.socket = deps.createSocket(REALTIME_WS_URL, { Authorization: `Bearer ${deps.apiKey}` });
    this.socket.on('open', () => {
      if (this.cancelled || this.state !== SocketState.Connecting) {
        this.socket.terminate();
        return;
      }
      this.state = SocketState.Open;
      // The documented latency knob, in its raw-WS form (verified live —
      // `session.updated` echoes the value).
      this.socket.send(
        JSON.stringify({
          type: 'session.update',
          session: { target_streaming_delay_ms: TARGET_STREAMING_DELAY_MS },
        }),
      );
      for (const chunk of this.pending) this.sendBinary(chunk);
      this.pending = [];
    });
    this.socket.on('message', (data, isBinary) => {
      if (isBinary || this.cancelled || this.state === SocketState.Closed) return;
      this.handleEvent(data.toString('utf8'));
    });
    this.socket.on('error', (err) => {
      if (this.cancelled) return;
      this.fail(redact(err.message, deps.keys));
    });
    this.socket.on('close', () => {
      if (this.cancelled) return;
      if (this.state !== SocketState.Finalising) this.state = SocketState.Closed;
      // A close before `input_audio.end` is a mid-stream failure; the stop
      // path decides what the commit does with it.
      if (!this.failed && this.finalText === null && this.state !== SocketState.Finalising) {
        this.fail('Realtime connection closed early.');
      }
      this.settleFinalise();
    });
    this.opened = this.wireOpened();
  }

  /** Wire the start-time open/error/close race that `beginVoiceStream`
   *  answers from. Runs in the constructor body — the socket must exist. */
  private wireOpened(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ok = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const bad = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => bad('Realtime connection timed out.'),
        this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      );
      this.rejectOpen = bad;
      this.socket.on('open', () => {
        clearTimeout(timer);
        if (this.cancelled) bad('Realtime recording cancelled.');
        else ok();
      });
      this.socket.on('error', () => {
        clearTimeout(timer);
        bad(this.failed ?? 'Realtime connection failed.');
      });
      this.socket.on('close', () => {
        clearTimeout(timer);
        bad(this.failed ?? 'Realtime connection closed.');
      });
    });
  }

  handleAudio(pcmBase64: string): void {
    if (this.finished) return;
    const bytes = Buffer.from(pcmBase64, 'base64');
    if (bytes.length === 0) return;
    if (this.pcmBytes + bytes.length <= MAX_PCM_BYTES) {
      this.pcm.push(bytes);
      this.pcmBytes += bytes.length;
    }
    if (this.state === SocketState.Open) {
      this.sendBinary(bytes);
    } else if (this.state === SocketState.Connecting) {
      // Before the upgrade lands — buffer so the first words are not lost
      // from the partial view, then flush on open.
      this.pending.push(bytes);
    }
    // Finalising/Closed: drop — the utterance is already ending.
  }

  private sendBinary(bytes: Buffer): void {
    try {
      this.socket.send(bytes, { binary: true });
    } catch (err) {
      this.fail(redact((err as Error).message, this.deps.keys));
    }
  }

  private handleEvent(raw: string): void {
    let msg: { type?: string; text?: unknown; error?: { message?: unknown } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // Non-JSON frame — ignore rather than fail a good session.
    }
    switch (msg.type) {
      case 'transcription.text.delta': {
        if (typeof msg.text === 'string' && msg.text.length > 0) {
          this.accumulated += msg.text;
          this.deps.onPartial(this.accumulated);
        }
        return;
      }
      case 'transcription.done': {
        // The done payload carries the authoritative final text.
        this.finalText = typeof msg.text === 'string' ? msg.text : this.accumulated;
        this.settleFinalise();
        return;
      }
      case 'error': {
        const detail =
          typeof msg.error?.message === 'string' ? msg.error.message : 'realtime error';
        this.fail(redact(detail, this.deps.keys));
        return;
      }
      default:
        return; // session.created / session.updated / unknown — nothing to do.
    }
  }

  private settleFinalise(): void {
    for (const w of this.finaliseWaiters) w();
    this.finaliseWaiters = [];
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = message;
    if (!this.finished) this.deps.onUnavailable?.();
    this.settleFinalise();
  }

  async stop(): Promise<VoiceTranscribeResult> {
    if (this.committed || this.cancelled) {
      // A second stop on an already-finalised session must not re-insert.
      return { inserted: false, reason: 'no-session' };
    }
    this.committed = true;
    this.finished = true;
    const outcome = await this.finalise();
    this.teardown();
    if (this.cancelled) return { inserted: false, reason: 'no-session' };
    return this.commit(outcome);
  }

  private async finalise(): Promise<{ streamFailed: boolean }> {
    if (this.state === SocketState.Open && this.finalText === null && !this.failed) {
      this.state = SocketState.Finalising;
      try {
        this.socket.send(JSON.stringify({ type: 'input_audio.end' }));
      } catch (err) {
        this.fail(redact((err as Error).message, this.deps.keys));
      }
      await new Promise<void>((resolve) => {
        if (this.finalText !== null || this.failed) {
          resolve();
          return;
        }
        this.finaliseWaiters.push(resolve);
        setTimeout(resolve, this.deps.finaliseTimeoutMs ?? FINALISE_TIMEOUT_MS);
      });
    }
    return { streamFailed: this.failed !== null };
  }

  private teardown(): void {
    this.state = SocketState.Closed;
    this.pending = [];
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }

  private async commit(outcome: { streamFailed: boolean }): Promise<VoiceTranscribeResult> {
    const streamText = this.finalText ?? this.accumulated;
    const biasNonEmpty = this.deps.contextBias.length > 0;

    // §8 final-text rule: a configured vocabulary routes the commit through
    // the bias-corrected batch repass first, keeping the realtime text as
    // the last resort. A failed stream falls back to the normal batch chain
    // on the reassembled clip too — the renderer's own buffered clip stays
    // the fallback only when main holds no audio at all.
    const repassNeeded = biasNonEmpty || outcome.streamFailed;
    if (repassNeeded && this.pcmBytes >= 2) {
      const clip = this.reassembledClip();
      if (clip) {
        const chain = biasNonEmpty
          ? this.deps.batchTranscribers.biasFirst
          : this.deps.batchTranscribers.normal;
        try {
          const transcript = await chain(clip);
          if (this.cancelled) return { inserted: false, reason: 'no-session' };
          return toTranscribeResult(
            this.deps.insert(this.deps.sid, transcript.text),
            transcript.provider,
            transcript.producer,
          );
        } catch {
          // Both batch providers failed — the realtime text is the last
          // resort the design keeps (§8).
        }
      }
    }
    return toTranscribeResult(
      this.deps.insert(this.deps.sid, streamText),
      'mistral',
      'mistral-realtime',
    );
  }

  private reassembledClip(): VoiceAudioClipLike | null {
    if (this.pcmBytes < 2) return null;
    // The header carries the rate the renderer actually captured at — the
    // same honesty rule as the recorder's own clip (voice-recorder.ts).
    const rate = this.deps.sampleRate ?? RECORD_SAMPLE_RATE;
    const merged = Buffer.concat(this.pcm, this.pcmBytes);
    const samples = new Int16Array(merged.buffer, merged.byteOffset, Math.floor(merged.length / 2));
    const wav = encodeWav(samples, rate);
    return {
      data: Buffer.from(wav).toString('base64'),
      sampleRate: rate,
      format: 'wav',
    };
  }

  cancel(): void {
    this.cancelled = true;
    this.finished = true;
    this.rejectOpen?.('Realtime recording cancelled.');
    this.settleFinalise();
    this.pcm = [];
    this.pcmBytes = 0;
    this.teardown();
    this.socket.terminate();
  }
}

/** Map an `InsertOutcome` to the result union the pane already knows. */
function toTranscribeResult(
  outcome: InsertOutcome,
  provider: VoiceProvider,
  producer: VoiceTranscriptProducer,
): VoiceTranscribeResult {
  if (outcome.inserted) {
    return { inserted: true, provider, producer, chars: outcome.chars };
  }
  return {
    inserted: false,
    reason: outcome.reason,
    producer: outcome.reason === 'empty-transcript' ? undefined : producer,
  };
}

function redact(text: string, keys: ResolvedVoiceKeys): string {
  let out = text;
  for (const key of [keys.openrouter, keys.mistral]) {
    if (key && out.includes(key)) out = out.split(key).join('***');
  }
  return out;
}

// ---------------------------------------------------------------------------
// The single-active-session holder (design §3: one stream at a time).
// ---------------------------------------------------------------------------

export interface VoiceStreamReservation {
  readonly ownerId: string;
  cancelled: boolean;
  session: VoiceStreamSessionImpl | null;
}

let active: VoiceStreamReservation | null = null;
const cancelledBeforeStart = new Set<string>();
export const MAX_PRESTART_CANCELLATIONS = 256;
const finishedOwners = new Set<string>();
const MAX_FINISHED_OWNERS = 256;
let admissionClosed = false;

// These are proofs of consumed one-shot starts, not cancellation protection.
// Eviction can only lose duplicate suppression; pending cancel markers never evict.
function rememberFinishedOwner(ownerId: string): void {
  if (finishedOwners.has(ownerId)) return;
  if (finishedOwners.size === MAX_FINISHED_OWNERS) {
    finishedOwners.delete(finishedOwners.values().next().value!);
  }
  finishedOwners.add(ownerId);
}

/** Reserve before settings/config awaits. Overflow closes admission for this
 *  process lifetime: no cancellation protection is ever evicted or timed out. */
export function reserveVoiceStream(
  ownerId: string,
):
  | { ok: true; reservation: VoiceStreamReservation }
  | { ok: false; reason: 'already-active' | 'error'; error?: string } {
  if (cancelledBeforeStart.delete(ownerId)) {
    rememberFinishedOwner(ownerId);
    return { ok: false, reason: 'error', error: 'Realtime recording cancelled.' };
  }
  if (finishedOwners.has(ownerId)) {
    return { ok: false, reason: 'error', error: 'Realtime recording already finished.' };
  }
  if (admissionClosed)
    return {
      ok: false,
      reason: 'error',
      error: 'Realtime admission closed; restart the application.',
    };
  if (active) {
    rememberFinishedOwner(ownerId);
    return { ok: false, reason: 'already-active' };
  }
  const reservation: VoiceStreamReservation = { ownerId, cancelled: false, session: null };
  active = reservation;
  return { ok: true, reservation };
}

export function ownsVoiceStream(reservation: VoiceStreamReservation): boolean {
  return active === reservation && !reservation.cancelled;
}

export function releaseVoiceStream(reservation: VoiceStreamReservation): void {
  rememberFinishedOwner(reservation.ownerId);
  if (active === reservation) active = null;
}

/**
 * Open the one realtime session. Reserves the active slot synchronously so
 * a concurrent second start is refused with `already-active`, then awaits
 * the (bounded) socket upgrade before answering ok. A failed start cleans
 * the slot up.
 */
export async function beginVoiceStream(
  deps: VoiceStreamSessionDeps,
  reserved?: VoiceStreamReservation,
): Promise<
  | {
      ok: true;
      session: VoiceStreamSessionImpl;
    }
  | { ok: false; reason: 'already-active' | 'error'; error?: string }
> {
  const admission = reserved
    ? { ok: true as const, reservation: reserved }
    : reserveVoiceStream(deps.ownerId);
  if (!admission.ok) return admission;
  const reservation = admission.reservation;
  if (!ownsVoiceStream(reservation) || reservation.ownerId !== deps.ownerId) {
    return { ok: false, reason: 'error', error: 'Realtime recording cancelled.' };
  }
  let session: VoiceStreamSessionImpl | null = null;
  try {
    session = new VoiceStreamSessionImpl(deps);
    reservation.session = session;
    await session.opened;
    if (!ownsVoiceStream(reservation)) {
      session.cancel();
      return { ok: false, reason: 'error', error: 'Realtime recording cancelled.' };
    }
    return { ok: true, session };
  } catch (err) {
    releaseVoiceStream(reservation);
    session?.cancel();
    return { ok: false, reason: 'error', error: (err as Error).message };
  }
}

/** The active stream's audio tap, or null. */
export function getActiveVoiceStream(ownerId?: string): VoiceStreamSession | null {
  return active && (ownerId === undefined || active.ownerId === ownerId) ? active.session : null;
}

/** Take the active stream out of the slot for a finalising stop. */
export function takeActiveVoiceStream(ownerId: string): VoiceStreamSession | null {
  if (active?.ownerId !== ownerId) return null;
  const session = active.session;
  rememberFinishedOwner(ownerId);
  active.cancelled = true;
  active = null;
  return session;
}

/** Abort the active stream (no commit). */
export function cancelActiveVoiceStream(ownerId: string): void {
  if (active?.ownerId === ownerId) {
    const reservation = active;
    reservation.cancelled = true;
    rememberFinishedOwner(ownerId);
    active = null;
    reservation.session?.cancel();
    return;
  }
  if (finishedOwners.has(ownerId) || cancelledBeforeStart.has(ownerId) || admissionClosed) return;
  if (cancelledBeforeStart.size === MAX_PRESTART_CANCELLATIONS) {
    admissionClosed = true;
    return;
  }
  cancelledBeforeStart.add(ownerId);
}
