import { ipcMain } from 'electron';
import { listTerminalSessions, tabRecentText, writeTerminal } from '../terminals';
import { readSettings } from '../settings';
import type {
  VoiceAudioClip,
  VoicePrefs,
  VoiceSpeakResult,
  VoiceTranscribeResult,
} from '../../shared/types';
import { resolveVoiceKeys } from '../voice/keys';
import { speakText, transcribeClip } from '../voice/adapter';
import { insertTranscript } from '../voice/insert';
import { resolveContextBias } from '../voice/resolve-context-bias';
import { getEffectiveConceptionConfig } from '../effective-config';
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
      return { inserted: true, provider: transcript.provider, chars: outcome.chars };
    }
    return { inserted: false, reason: outcome.reason } satisfies VoiceTranscribeResult;
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
}
