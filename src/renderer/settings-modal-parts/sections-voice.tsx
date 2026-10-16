import { createEffect, For, Show, type JSX } from 'solid-js';
import type { VoiceKeyStatus, VoicePrefs } from '@shared/types';
import { type RawConfig } from './data';
import { SectionShell } from './section-shell';
import { createVoiceKeyStatus } from './voice-key-status';

interface VoiceSectionProps {
  parsed: () => RawConfig;
  patch: (mutator: (config: RawConfig) => void) => Promise<void>;
  active: boolean;
  savedRevision: number;
}

export function VoiceSection(props: VoiceSectionProps): JSX.Element {
  const voice = (): VoicePrefs => props.parsed().voice ?? {};
  const update = (partial: Partial<VoicePrefs>): Promise<void> =>
    props.patch((config) => {
      config.voice = { ...config.voice, ...partial };
    });
  const biasLines = (): string[] => voice().contextBias ?? [];
  const updateBias = (text: string): Promise<void> =>
    update({
      contextBias: text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 100),
    });
  const keys = createVoiceKeyStatus(() => window.condash.voiceCredentialStatus());
  let lastSavedRevision = -1;
  createEffect(() => {
    const saved = props.savedRevision;
    const active = props.active;
    if (saved !== lastSavedRevision || active) void keys.refresh();
    lastSavedRevision = saved;
  });
  const keyDescription = (status: VoiceKeyStatus): string =>
    status.present
      ? `Key ${status.source === 'agents-env' ? 'found in the shared API-key file' : 'entered in Settings'} — not tested with provider`
      : 'No API key found';
  const sttModel = () => voice().sttModel?.trim() || 'mistralai/voxtral-small-24b-2507';
  const ttsModel = () => voice().ttsModel?.trim() || 'mistralai/voxtral-mini-tts-2603';

  return (
    <SectionShell
      id="voice"
      title="Voice"
      scope="global"
      hint={
        <p class="settings-hint">
          Dictate inserts speech into a terminal tab after Stop. Read speaks recent tab output. Both
          are idle until requested.
        </p>
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
            <span>Enable voice controls (Dictate and Read)</span>
          </label>
          <small class="settings-field-hint">
            Off by default. When off, neither control captures audio or contacts a provider.
          </small>
        </div>
      </div>

      <Show when={voice().enabled}>
        <fieldset class="settings-launcher-fieldset" aria-label="Dictation">
          <legend>Dictation</legend>
          <p class="settings-hint" data-test-dictation-route>
            <strong>Draft route if saved:</strong>{' '}
            <Show
              when={voice().streaming ?? true}
              fallback={
                <>
                  Clip after Stop → OpenRouter ({sttModel()}) → Mistral batch fallback. No live
                  captions.
                </>
              }
            >
              Mistral realtime while speaking. With effective vocabulary, Stop → Mistral batch →
              OpenRouter ({sttModel()}) → realtime text as last resort. Without vocabulary: realtime
              text; on stream failure, OpenRouter → Mistral batch → realtime text.
            </Show>{' '}
            Only keyed providers are attempted. Unavailable streaming keeps recording for batch
            transcription after Stop. This is a draft preview, not a saved setup or an actual
            action.
          </p>
          <div class="settings-grid">
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
                Requires a Mistral key. Fixed realtime model:{' '}
                <code>voxtral-mini-transcribe-realtime-2602</code>; fixed provider delay target:
                1000 ms (not end-to-end latency).
              </small>
            </div>
            <label class="settings-field-span">
              <span>OpenRouter transcription model (batch only)</span>
              <input
                type="text"
                placeholder="mistralai/voxtral-small-24b-2507"
                value={voice().sttModel ?? ''}
                onInput={(e) =>
                  void update({ sttModel: e.currentTarget.value.trim() || undefined })
                }
              />
              <small class="settings-field-hint">
                Audio-input chat model, not the live model. Mistral batch always uses{' '}
                <code>voxtral-mini-latest</code>.
              </small>
            </label>
            <label class="settings-field-span">
              <span>Context bias — vocabulary ({biasLines().length}/100)</span>
              <textarea
                rows={4}
                placeholder={'condash\nknoten\nvcoeur'}
                value={biasLines().join('\n')}
                onChange={(e) => void updateBias(e.currentTarget.value)}
              />
              <small class="settings-field-hint">
                One phrase per line. App handles/names/aliases are added automatically: an empty
                field need not mean empty effective vocabulary.{' '}
                <Show
                  when={voice().streaming ?? true}
                  fallback={
                    <>
                      Batch-only dictation uses OpenRouter glossary → Mistral native batch bias,
                      with no realtime last resort.
                    </>
                  }
                >
                  For an established live stream, effective vocabulary selects a Stop re-check:
                  Mistral native batch bias → OpenRouter glossary → realtime text. This can add a
                  second charge and stop latency. Refused or pending stream startup instead uses
                  OpenRouter → Mistral batch, with no realtime last resort.
                </Show>{' '}
                The mechanisms do not promise equivalent accuracy.
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
                Hold to record, release to insert. Default Ctrl+Shift+Space; empty disables the
                shortcut.
              </small>
            </label>
          </div>
        </fieldset>

        <fieldset class="settings-launcher-fieldset" aria-label="Credentials">
          <legend>Credentials</legend>
          <p class="settings-hint">
            Saved key sources only; unsaved keys below do not change this snapshot. The shared
            API-key file wins over the manual Settings field. Default file:{' '}
            <code>~/.config/agents/.env</code> (CONDASH_AGENTS_ENV may override it). Finding a key
            does not test it with the provider; no provider request is made.
          </p>
          <div class="voice-key-snapshot" role="status" data-test-voice-keys>
            <Show
              when={keys.snapshot().phase === 'checked'}
              fallback={
                <p>
                  {keys.snapshot().phase === 'pending'
                    ? 'Refreshing — key sources not checked; any previous snapshot is stale.'
                    : keys.snapshot().phase === 'error'
                      ? 'Refresh failed — key sources not checked; any previous snapshot is stale.'
                      : 'Key sources not checked.'}
                </p>
              }
            >
              {(() => {
                const snapshot = keys.snapshot();
                if (snapshot.phase !== 'checked') return null;
                return (
                  <>
                    <p>Last checked saved key sources at {snapshot.checkedAt}</p>
                    <For each={['openrouter', 'mistral'] as const}>
                      {(provider) => (
                        <p>
                          {provider === 'openrouter' ? 'OpenRouter' : 'Mistral'}:{' '}
                          {keyDescription(snapshot.keys[provider])}
                        </p>
                      )}
                    </For>
                  </>
                );
              })()}
            </Show>
          </div>
          <button type="button" class="btn" onClick={() => void keys.refresh()}>
            Refresh saved key sources
          </button>
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
            </label>
          </div>
          <small class="settings-field-hint">
            Manual keys are stored in this machine's settings.json and prefilled here. Environment
            key values stay in main.
          </small>
        </fieldset>

        <fieldset class="settings-launcher-fieldset" aria-label="Read aloud">
          <legend>Read aloud</legend>
          <p class="settings-hint" data-test-read-route>
            <strong>Draft route if saved:</strong> OpenRouter speech → Mistral fallback (requires
            both a Mistral key and voice id). Both use {ttsModel()}. This preview does not validate
            the model, voice or credentials.
          </p>
          <div class="settings-grid">
            <label>
              <span>Speech model</span>
              <input
                type="text"
                placeholder="mistralai/voxtral-mini-tts-2603"
                value={voice().ttsModel ?? ''}
                onInput={(e) =>
                  void update({ ttsModel: e.currentTarget.value.trim() || undefined })
                }
              />
              <small class="settings-field-hint">Model id passed to both speech providers.</small>
            </label>
            <label>
              <span>Speech voice</span>
              <input
                type="text"
                placeholder="en_paul_neutral"
                value={voice().ttsVoice ?? ''}
                onInput={(e) =>
                  void update({ ttsVoice: e.currentTarget.value.trim() || undefined })
                }
              />
              <small class="settings-field-hint">
                OpenRouter voice: {voice().ttsVoice?.trim() || 'en_paul_neutral'}. Voice ids are
                model-specific.
              </small>
            </label>
            <label>
              <span>Mistral voice id (fallback)</span>
              <input
                type="text"
                placeholder="(unset — fallback skipped)"
                value={voice().mistralVoiceId ?? ''}
                onInput={(e) =>
                  void update({ mistralVoiceId: e.currentTarget.value.trim() || undefined })
                }
              />
              <small class="settings-field-hint">
                {voice().mistralVoiceId?.trim()
                  ? 'Voice id configured in this draft; a Mistral key is also required.'
                  : 'Unset in this draft — Mistral speech fallback skipped.'}
              </small>
            </label>
          </div>
        </fieldset>
        <p class="settings-hint">
          Privacy: streaming sends audio while speaking; batch uploads/correction can continue after
          Stop releases the mic. No always-on capture or persisted audio. Captions are display-only;
          final text is inserted once after Stop. Actual action stages appear by Dictate, not in
          this Settings preview.
        </p>
      </Show>
    </SectionShell>
  );
}
