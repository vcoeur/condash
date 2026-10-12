/**
 * Voice section of the Settings modal — a personal (per-machine) setting.
 *
 * Configures push-to-talk dictation + on-demand readback for terminal panes.
 * Voice is **default-off**: a single master switch gates the whole feature;
 * the provider fields only render while it is on. The provider API keys are
 * secrets: they live in the global `settings.json` only, never a tree's
 * settings file. By default keys are read read-only from
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
  /** One phrase per line in the textarea ↔ `contextBias` array. Blank lines
   *  never enter the draft (they'd waste the 100-entry budget), and the cap
   *  is enforced here: extra lines beyond 100 are ignored, so the counter
   *  cannot pass 100 and the save cannot be rejected. Trim/dedup at use time
   *  stays the resolver's job (main-side, seeded with app handles). */
  const biasLines = (): string[] => voice().contextBias ?? [];
  const updateBias = (text: string): Promise<void> =>
    update({
      contextBias: text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 100),
    });

  return (
    <SectionShell
      id="voice"
      title="Voice"
      scope="global"
      hint={
        <>
          <p class="settings-hint">
            Push-to-talk dictation and on-demand readback for terminal tabs. Off by default — until
            you enable it below, tabs show no voice controls and nothing records or speaks. When
            enabled, the Dictate control in a tab strip records only while toggled on, then inserts
            the transcript as typed input; with streaming on, the words appear as a temporary
            caption while you speak; the Read control speaks the tab's recent output. Both stay idle
            until clicked, and the tab keeps keyboard focus while you click them.
          </p>
          <p class="settings-hint">
            <strong>Privacy:</strong> audio is sent to the speech provider only while a dictation is
            active — streamed in small chunks to Mistral's realtime endpoint as you speak, when
            streaming is enabled — and the microphone is released the moment you stop. Nothing is
            sent outside an active dictation; no always-on capture exists; condash keeps no copy of
            clips or audio; partial text is shown locally and never typed into the terminal until
            you stop.
          </p>
        </>
      }
    >
      <div class="settings-grid">
        <div class="settings-field-span">
          <label class="settings-checkbox">
            <input
              type="checkbox"
              checked={voice().enabled ?? false}
              onChange={(e) => void update({ enabled: e.currentTarget.checked })}
            />
            <span>Enable voice dictation</span>
          </label>
          <small class="settings-field-hint">
            Adds the Dictate and Read controls to terminal tab strips. Recorded clips and read-aloud
            text are sent to the configured speech provider (keys below, or your{' '}
            <code>~/.config/agents/.env</code> entries). Off by default.
          </small>
        </div>

        <Show when={voice().enabled}>
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
              OpenRouter audio-input model. Default <code>mistralai/voxtral-small-24b-2507</code>;
              the Mistral fallback always uses <code>voxtral-mini-latest</code>.
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
              <code>gb_jane_*</code>, <code>fr_marie_*</code>). Default <code>en_paul_neutral</code>
              .
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
                Optional. Without an id the Mistral TTS fallback is skipped (its API has no
                anonymous preset voice) and read-aloud relies on OpenRouter alone.
              </Show>
              <Show when={voice().mistralVoiceId}>
                Used only by the Mistral fallback — a preset or saved voice id from Mistral's
                text-to-speech API.
              </Show>
            </small>
          </label>

          <div class="settings-field-span">
            <label class="settings-checkbox">
              <input
                type="checkbox"
                checked={voice().streaming ?? true}
                onChange={(e) => void update({ streaming: e.currentTarget.checked })}
              />
              <span>Stream dictation live (partial text while speaking)</span>
            </label>
            <small class="settings-field-hint">
              While recording, audio streams to Mistral's realtime endpoint and the forming
              transcript shows as a temporary caption under the tab strip; the final text is
              inserted once, when you stop. Off restores batch-only dictation (the clip is
              transcribed on stop). A stream failure always falls back to batch — this switch only
              decides whether the stream is opened.
            </small>
          </div>

          <label class="settings-field-span">
            <span>Context bias — vocabulary to spell exactly ({biasLines().length}/100)</span>
            <textarea
              rows={4}
              placeholder={'condash\nknoten\nvcoeur'}
              value={biasLines().join('\n')}
              onChange={(e) => void updateBias(e.currentTarget.value)}
            />
            <small class="settings-field-hint">
              One phrase per line — names, app handles, project slugs. Sent as bias hints on the
              transcription requests; the open conception's app handles are added automatically. A
              non-empty list also re-checks a streamed dictation's final text against the batch
              provider (adds ~1–2 s on stop); leave empty for the fast single pass.
            </small>
          </label>

          <label>
            <span>Push-to-talk shortcut</span>
            <input
              type="text"
              placeholder="Ctrl+Shift+Space"
              value={voice().pptShortcut ?? ''}
              onChange={(e) => void update({ pptShortcut: e.currentTarget.value.trim() })}
            />
            <small class="settings-field-hint">
              Hold to dictate, release to insert (no mouse needed). Default{' '}
              <code>Ctrl+Shift+Space</code>; empty disables push-to-talk.
            </small>
          </label>
        </Show>
      </div>
    </SectionShell>
  );
}
