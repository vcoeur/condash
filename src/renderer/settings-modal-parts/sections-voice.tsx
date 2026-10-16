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
            <strong>Privacy:</strong> capture requires an explicit dictation action. Streaming sends
            PCM chunks to Mistral while you speak. Stop releases the microphone immediately, but
            buffered uploads, bias repasses, and provider processing can continue afterward. There
            is no always-on capture and condash does not persist clips or audio. Partials are local
            display only; the final transcript is inserted after stop. Provider calls and
            environment keys stay in main; manually entered Settings keys are displayed back by
            Settings prefill.
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
          <div class="settings-field-span">
            <small class="settings-field-hint">
              <Show
                when={voice().streaming ?? true}
                fallback={
                  <>
                    Routing with streaming off: your clip → OpenRouter (transcription model) →
                    fallback Mistral batch. Read aloud → OpenRouter (speech model), Mistral fallback
                    (needs the Mistral voice id below).
                  </>
                }
              >
                Routing with streaming on: your voice → Mistral realtime (live caption) → on
                release, a Mistral batch re-check with the vocabulary below → fallback OpenRouter
                (transcription model) → fallback the stream's own text. Read aloud → OpenRouter
                (speech model), Mistral fallback (needs the Mistral voice id below).
              </Show>
            </small>
          </div>

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
              Feeds batch dictation, the streaming fallback, and read-aloud. Stored in this
              machine's <code>settings.json</code> only. Leave blank to fall back to the{' '}
              <code>OPENROUTER_API_KEY</code> entry in <code>~/.config/agents/.env</code>.
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
              Powers the live stream while streaming is on (a key is required to stream) and the
              first leg of the streamed-stop bias re-check; otherwise the batch fallback when
              OpenRouter is unkeyed or fails. Leave blank to fall back to the{' '}
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
              The OpenRouter transcription model, used on batch calls only. While streaming is on,
              batch is the fallback path — the live stream and the first re-check leg use Mistral's
              fixed models. With streaming off this is the primary dictation model. Default{' '}
              <code>mistralai/voxtral-small-24b-2507</code>; the Mistral batch fallback always uses{' '}
              <code>voxtral-mini-latest</code>.
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
              The read-aloud model, sent to whichever TTS provider answers — OpenRouter first,
              Mistral fallback (which additionally needs a Mistral voice id below). Default{' '}
              <code>mistralai/voxtral-mini-tts-2603</code>; use an id the provider lists.
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
              The voice id sent to the OpenRouter speech endpoint — model-specific (Voxtral personas
              look like <code>en_paul_neutral</code>; other speech models take their own ids).
              Default <code>en_paul_neutral</code>.
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
              While recording, audio streams to Mistral's realtime transcription endpoint (
              <code>voxtral-mini-transcribe-realtime-2602</code> — fixed, not a setting) and the
              forming transcript shows as a temporary caption under the tab strip, about a second
              behind your voice (provider-side delay, fixed). The final text is inserted once after
              stop. Off restores batch-only dictation. Startup failures keep the buffered batch
              path; main handles mid-stream failures. A failed stop reply does not launch another
              upload because main may already have inserted.
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
              One phrase per line — names, app handles, project slugs. The open conception's app
              handles are added automatically. A non-empty effective list routes a streamed stop
              through a re-check whose provider order is fixed: Mistral batch with these phrases as
              native bias fields first, OpenRouter with the transcription model (prompt glossary)
              second, the raw stream text last — adding provider-dependent stop latency and
              potentially a second transcription charge for the same audio. An empty user list does
              not disable the re-check when automatic app seeding makes the effective list
              non-empty.
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
