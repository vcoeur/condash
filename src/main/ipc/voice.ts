import { ipcMain } from 'electron';
import { listTerminalSessions, tabRecentText, writeTerminal } from '../terminals';
import { readSettings } from '../settings';
import type {
  VoiceAudioClip,
  VoicePartialMessage,
  VoicePrefs,
  VoiceSpeakResult,
  VoiceStreamStartResult,
  VoiceTranscribeResult,
} from '../../shared/types';
import { EVENT_CHANNELS } from '../../shared/ipc-channels';
import { resolveVoiceKeys, voiceCredentialStatus } from '../voice/keys';
import { speakText, transcribeClip, transcribeClipBiasFirst } from '../voice/adapter';
import { insertTranscript } from '../voice/insert';
import { resolveContextBias } from '../voice/resolve-context-bias';
import {
  beginVoiceStream,
  cancelActiveVoiceStream,
  createRealtimeSocket,
  getActiveVoiceStream,
  takeActiveVoiceStream,
  reserveVoiceStream,
  ownsVoiceStream,
  releaseVoiceStream,
} from '../voice/stream';
import type { VoiceAudioClipLike } from '../voice/stream';
import { getEffectiveConceptionConfig } from '../effective-config';
import { safeSend } from '../safe-send';
import {
  requireMainWindowSender,
  requireNonEmptyString,
  requireRecord,
  withConception,
} from './utils';

/** Base64 length cap on an uploaded clip (~20 MB of WAV ≈ 10 min of 16 kHz
 *  mono — far past any push-to-talk utterance; the bound exists so a wedged
 *  renderer cannot OOM main with one IPC payload). */
const MAX_CLIP_BASE64_CHARS = 20_000_000;

/** Base64 length cap on one streamed PCM chunk. The renderer sends ~256 ms
 *  frames (~11 KB base64); the bound keeps a wedged renderer from shipping
 *  an unbounded payload per call, same reasoning as the clip cap. */
const MAX_STREAM_CHUNK_BASE64_CHARS = 1_000_000;

/** Chars of recent pane output fed to the TTS readback. The same spirit as
 *  the dashboard's slice, tuned shorter: this text is billed per character
 *  on the speech endpoints and read aloud verbatim. */
const TTS_INPUT_CHARS = 4000;

/** Structural validation of the renderer-supplied clip. Throws the uniform
 *  `<channel>: expected …` shape on a malformed payload. */
function requireAudioClip(channel: string, value: unknown): VoiceAudioClip {
  const record = requireRecord(channel, value);
  const data = record.data;
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error(`${channel}: expected a non-empty base64 clip`);
  }
  if (data.length > MAX_CLIP_BASE64_CHARS) {
    throw new Error(`${channel}: clip too large`);
  }
  const sampleRate = record.sampleRate;
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`${channel}: expected a positive sampleRate`);
  }
  if (record.format !== 'wav') {
    throw new Error(`${channel}: expected format 'wav'`);
  }
  return { data, sampleRate, format: 'wav' };
}

/** Structural validation of a streamed PCM chunk. Throws the uniform
 *  `<channel>: expected …` shape on a malformed payload. */
function requireStreamChunk(
  channel: string,
  value: unknown,
): { ownerId: string; pcmBase64: string } {
  const record = requireRecord(channel, value);
  const pcmBase64 = record.pcmBase64;
  if (typeof pcmBase64 !== 'string' || pcmBase64.length === 0) {
    throw new Error(`${channel}: expected a non-empty pcmBase64 string`);
  }
  if (pcmBase64.length > MAX_STREAM_CHUNK_BASE64_CHARS) {
    throw new Error(`${channel}: chunk too large`);
  }
  return { ownerId: requireOwnerId(channel, record.ownerId), pcmBase64 };
}

function requireOwnerId(channel: string, value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${channel}: expected an opaque ownerId (1–128 characters)`);
  }
  return value;
}

/** True when `sid` names a session that can still accept input (unknown ids
 *  and exited rows are both dead ends for insertion). */
function sessionIsLive(sid: string): boolean {
  return listTerminalSessions().some((s) => s.id === sid && s.exited === undefined);
}

/** Resolve the effective context-bias list for one transcription: the user's
 *  `voice.contextBias` phrases merged with the open conception's app
 *  handles/names/aliases (§8). No conception → the user list alone. */
async function effectiveContextBias(prefs: VoicePrefs | undefined): Promise<string[]> {
  return withConception(
    async (conceptionPath) => {
      const config = await getEffectiveConceptionConfig(conceptionPath);
      return resolveContextBias(prefs?.contextBias, config.repositories);
    },
    resolveContextBias(prefs?.contextBias, undefined),
  );
}

/** Wire the voice dictation + readback handlers. Called once from main entry.
 *
 *  Both handlers are gated on `voice.enabled` (default off): when the feature
 *  is not explicitly enabled they answer with a typed disabled result — no
 *  provider call, no key resolution, no recording side effect. Argument
 *  validation still runs first so the trust boundary keeps its uniform
 *  `<channel>: expected …` shape. */
export function registerVoiceIpc(): void {
  ipcMain.handle('voiceCredentialStatus', async (event) => {
    requireMainWindowSender(event);
    try {
      const { voice } = await readSettings();
      return voiceCredentialStatus(voice);
    } catch {
      throw new Error('Could not read saved voice credential status.');
    }
  });

  ipcMain.handle('voiceTranscribe', async (event, id: unknown, clip: unknown) => {
    requireMainWindowSender(event);
    const sid = requireNonEmptyString('voiceTranscribe', id);
    const audio = requireAudioClip('voiceTranscribe', clip);
    const { voice: prefs } = await readSettings();
    if (prefs?.enabled !== true) {
      return { inserted: false, reason: 'disabled' } satisfies VoiceTranscribeResult;
    }
    const keys = resolveVoiceKeys(prefs);
    // Adapter errors are pre-redacted; let them reject so the renderer toast
    // shows the reason instead of a silent no-op.
    const transcript = await transcribeClip(
      audio,
      keys,
      prefs,
      undefined,
      await effectiveContextBias(prefs),
    );
    const outcome = insertTranscript(sid, transcript.text, {
      isLive: sessionIsLive,
      write: writeTerminal,
    });
    if (outcome.inserted) {
      return {
        inserted: true,
        provider: transcript.provider,
        producer: transcript.producer,
        chars: outcome.chars,
      };
    }
    return {
      inserted: false,
      reason: outcome.reason,
      producer: transcript.producer,
    } satisfies VoiceTranscribeResult;
  });

  ipcMain.handle('voiceSpeak', async (event, id: unknown) => {
    requireMainWindowSender(event);
    const sid = requireNonEmptyString('voiceSpeak', id);
    const { voice: prefs } = await readSettings();
    if (prefs?.enabled !== true) {
      return {
        ok: false,
        reason: 'disabled',
        error: 'Voice is disabled — enable it in Settings → Voice.',
      } satisfies VoiceSpeakResult;
    }
    const text = tabRecentText(sid, TTS_INPUT_CHARS).trim();
    if (!text) {
      return { ok: false, error: 'No recent output in this tab to read aloud.' };
    }
    const keys = resolveVoiceKeys(prefs);
    try {
      const spoken = await speakText(text, keys, prefs);
      const result: VoiceSpeakResult = {
        ok: true,
        audioBase64: Buffer.from(spoken.audio).toString('base64'),
        mime: 'audio/mpeg',
        provider: spoken.provider,
      };
      return result;
    } catch (err) {
      const result: VoiceSpeakResult = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      return result;
    }
  });

  // --- Realtime dictation stream -----------------------------------------
  // Same gates and validation-first shape as the batch handlers: a stream
  // start that hits a disabled feature or a missing Mistral key answers a
  // typed refusal and the renderer stays on the batch path (design §9.1).

  ipcMain.handle('voiceStreamStart', async (event, request: unknown) => {
    requireMainWindowSender(event);
    const record = requireRecord('voiceStreamStart', request);
    const sid = requireNonEmptyString('voiceStreamStart', record.sid);
    const sampleRate = record.sampleRate;
    if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('voiceStreamStart: expected a positive sampleRate');
    }
    const ownerId = requireOwnerId('voiceStreamStart', record.ownerId);
    const admission = reserveVoiceStream(ownerId);
    if (!admission.ok) return admission satisfies VoiceStreamStartResult;
    const reservation = admission.reservation;
    let accepted = false;
    const cancelled = (): VoiceStreamStartResult => ({
      ok: false,
      reason: 'error',
      error: 'Realtime recording cancelled.',
    });
    try {
      const { voice: prefs } = await readSettings();
      if (!ownsVoiceStream(reservation)) return cancelled();
      if (prefs?.enabled !== true || prefs.streaming === false) {
        return { ok: false, reason: 'disabled' } satisfies VoiceStreamStartResult;
      }
      const keys = resolveVoiceKeys(prefs);
      if (!keys.mistral) {
        return { ok: false, reason: 'no-mistral-key' } satisfies VoiceStreamStartResult;
      }
      const contextBias = await effectiveContextBias(prefs);
      if (!ownsVoiceStream(reservation)) return cancelled();
      const sender = event.sender;
      const batchTranscribers = {
        normal: (clip: VoiceAudioClipLike) =>
          transcribeClip(clip, keys, prefs, undefined, contextBias),
        biasFirst: (clip: VoiceAudioClipLike) =>
          transcribeClipBiasFirst(clip, keys, prefs, undefined, contextBias),
      };
      const started = await beginVoiceStream(
        {
          ownerId,
          sid,
          sampleRate,
          apiKey: keys.mistral,
          contextBias,
          keys,
          prefs,
          createSocket: createRealtimeSocket,
          onPartial: (text) => {
            safeSend(sender, EVENT_CHANNELS.voicePartial, {
              ownerId,
              sid,
              text,
            } satisfies VoicePartialMessage);
          },
          onUnavailable: () => {
            safeSend(sender, EVENT_CHANNELS.voicePartial, {
              ownerId,
              sid,
              text: '',
              unavailable: true,
            } satisfies VoicePartialMessage);
          },
          insert: (insertSid, text) =>
            insertTranscript(insertSid, text, { isLive: sessionIsLive, write: writeTerminal }),
          batchTranscribers,
        },
        reservation,
      );
      if (!ownsVoiceStream(reservation)) return cancelled();
      if (started.ok) {
        accepted = true;
        return { ok: true } satisfies VoiceStreamStartResult;
      }
      return started satisfies VoiceStreamStartResult;
    } finally {
      if (!accepted) releaseVoiceStream(reservation);
    }
  });

  ipcMain.handle('voiceStreamAudio', async (event, chunk: unknown) => {
    requireMainWindowSender(event);
    const payload = requireStreamChunk('voiceStreamAudio', chunk);
    const { voice: prefs } = await readSettings();
    if (prefs?.enabled !== true) {
      // The feature was switched off mid-recording — tear the socket down so
      // no audio keeps flowing after the gate would have refused it.
      cancelActiveVoiceStream(payload.ownerId);
      return;
    }
    getActiveVoiceStream(payload.ownerId)?.handleAudio(payload.pcmBase64);
  });

  ipcMain.handle('voiceStreamStop', async (event, requestOwner: unknown) => {
    requireMainWindowSender(event);
    const ownerId = requireOwnerId('voiceStreamStop', requestOwner);
    const { voice: prefs } = await readSettings();
    if (prefs?.enabled !== true) {
      cancelActiveVoiceStream(ownerId);
      return { inserted: false, reason: 'disabled' } satisfies VoiceTranscribeResult;
    }
    const session = takeActiveVoiceStream(ownerId);
    if (!session) {
      // The stream already died (or never started) — the renderer answers
      // with its buffered-clip batch chain (§9.3).
      return { inserted: false, reason: 'no-session' } satisfies VoiceTranscribeResult;
    }
    return session.stop();
  });

  ipcMain.handle('voiceStreamCancel', async (event, requestOwner: unknown) => {
    requireMainWindowSender(event);
    cancelActiveVoiceStream(requireOwnerId('voiceStreamCancel', requestOwner));
  });
}
