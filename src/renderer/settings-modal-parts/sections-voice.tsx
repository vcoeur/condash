/**
 * Voice section of the Settings modal — a personal (per-machine) setting.
 *
 * Configures push-to-talk dictation + on-demand readback for terminal panes.
 * The provider API keys are secrets: they live in the global `settings.json`
 * only, never a tree's settings file. By default keys are read read-only from
 * `~/.config/agents/.env` (`OPENROUTER_API_KEY` / `MISTRAL_API_KEY`); the
 * fields here are the manual fallback for machines without that file.
 */

import { Show, type JSX } from 'solid-js';
import type { VoicePrefs } from '@shared/types';
import { type RawConfig } from './data';
import { SectionShell } from './section-shell';

interface VoiceSectionProps {
  /** Draft-aware getter for the global file. */
  parsed: () => RawConfig;
  /** Stage a mutation to the global draft. */
  patch: (mutator: (config: RawConfig) => void) => Promise<void>;
}

export function VoiceSection(props: VoiceSectionProps): JSX.Element {
  const voice = (): VoicePrefs => props.parsed().voice ?? {};
  const update = (partial: Partial<VoicePrefs>): Promise<void> =>
    props.patch((config) => {
      config.voice = { ...config.voice, ...partial };
    });

  return (
    <SectionShell
      id="voice"
      title="Voice"
      scope="global"
      hint={
        <>
          <p class="settings-hint">
            Push-to-talk dictation and on-demand readback for terminal tabs. The Dictate control in
            a tab strip records only while toggled on, then inserts the transcript as typed input;
            the Read control speaks the tab's recent output. Both stay idle until clicked.
          </p>
          <p class="settings-hint">
            <strong>Privacy:</strong> a clip is sent to the configured speech provider only while
            you are recording and only on stop; read-aloud sends the tab's recent output text to the
            provider when you click Read. Nothing is recorded, transmitted, or stored by condash
            outside those actions.
          </p>
        </>
      }
    >
      <div class="settings-grid">
        <label>
          <span>OpenRouter API key</span>
          <input
            type="password"
            autocomplete="off"
            placeholder="sk-or-…"
            value={voice().openrouterApiKey ?? ''}
            onChange={(e) =>
              void update({ openrouterApiKey: e.currentTarget.value.trim() || undefined })
            }
          />
          <small class="settings-field-hint">
            Stored in this machine's <code>settings.json</code> only. Leave blank to fall back to
            the <code>OPENROUTER_API_KEY</code> entry in <code>~/.config/agents/.env</code>.
          </small>
        </label>
        <label>
          <span>Mistral API key</span>
          <input
            type="password"
            autocomplete="off"
            placeholder="…"
            value={voice().mistralApiKey ?? ''}
            onChange={(e) =>
              void update({ mistralApiKey: e.currentTarget.value.trim() || undefined })
            }
          />
          <small class="settings-field-hint">
            Fallback provider when OpenRouter is unkeyed or fails. Leave blank to fall back to the{' '}
            <code>MISTRAL_API_KEY</code> entry in <code>~/.config/agents/.env</code>.
          </small>
        </label>

        <label>
          <span>Transcription model</span>
          <input
            type="text"
            placeholder="mistralai/voxtral-small-24b-2507"
            value={voice().sttModel ?? ''}
            onChange={(e) => void update({ sttModel: e.currentTarget.value.trim() || undefined })}
          />
          <small class="settings-field-hint">
            OpenRouter audio-input model. Default <code>mistralai/voxtral-small-24b-2507</code>; the
            Mistral fallback always uses <code>voxtral-mini-latest</code>.
          </small>
        </label>
        <label>
          <span>Speech model</span>
          <input
            type="text"
            placeholder="mistralai/voxtral-mini-tts-2603"
            value={voice().ttsModel ?? ''}
            onChange={(e) => void update({ ttsModel: e.currentTarget.value.trim() || undefined })}
          />
          <small class="settings-field-hint">
            Text-to-speech model on both providers. Default{' '}
            <code>mistralai/voxtral-mini-tts-2603</code>.
          </small>
        </label>
        <label>
          <span>Speech voice</span>
          <input
            type="text"
            placeholder="en_paul_neutral"
            value={voice().ttsVoice ?? ''}
            onChange={(e) => void update({ ttsVoice: e.currentTarget.value.trim() || undefined })}
          />
          <small class="settings-field-hint">
            Voxtral voice id — the prefix carries the language (<code>en_paul_*</code>,{' '}
            <code>gb_jane_*</code>, <code>fr_marie_*</code>). Default <code>en_paul_neutral</code>.
          </small>
        </label>
        <label>
          <span>Mistral voice id (fallback)</span>
          <input
            type="text"
            placeholder="(unset — fallback skipped)"
            value={voice().mistralVoiceId ?? ''}
            onChange={(e) =>
              void update({ mistralVoiceId: e.currentTarget.value.trim() || undefined })
            }
          />
          <small class="settings-field-hint">
            <Show when={!voice().mistralVoiceId}>
              Optional. Without an id the Mistral TTS fallback is skipped (its API has no anonymous
              preset voice) and read-aloud relies on OpenRouter alone.
            </Show>
            <Show when={voice().mistralVoiceId}>
              Used only by the Mistral fallback — a preset or saved voice id from Mistral's
              text-to-speech API.
            </Show>
          </small>
        </label>
      </div>
    </SectionShell>
  );
}
