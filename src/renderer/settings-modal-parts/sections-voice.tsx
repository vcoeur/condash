import { createEffect, createSignal, Show, type JSX } from 'solid-js';
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
  const audioContext = () => voice().dictationMethod === 'audio-context';
  const sttModel = () =>
    audioContext()
      ? voice().audioContextModel?.trim() || 'google/gemini-2.5-flash'
      : voice().sttModel?.trim() || 'mistralai/voxtral-mini-transcribe';
  const methodLabel = () => (audioContext() ? 'Audio + context' : 'Native STT');
  const [editingModel, setEditingModel] = createSignal(false);
  const ttsModel = () => voice().ttsModel?.trim() || 'mistralai/voxtral-mini-tts-2603';

  return (
    <SectionShell
      id="voice"
      title="Voice"
      scope="global"
      hint={
        <p class="settings-hint">
          OpenRouter only — Dictate and Read share one OpenRouter API key, with no direct-provider
          fallback. Dictate inserts speech into a terminal tab after Stop. Read speaks recent tab
          output. Both are idle until requested. Model ids starting with mistralai/ refer to models
          accessed through OpenRouter; no Mistral credentials are needed.
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
            <strong>Draft route if saved:</strong> {methodLabel()} →{' '}
            <Show
              when={voice().streaming ?? true}
              fallback={
                <>No live captions. Full recording after Stop → OpenRouter ({sttModel()}).</>
              }
            >
              Periodic captions while recording → OpenRouter ({sttModel()}). Stop → full recording
              with vocabulary hints → the same model ({sttModel()}). Final text may revise captions.
            </Show>{' '}
            OpenRouter key required. No alternate provider or model fallback. This is a draft
            preview, not a saved setup or an actual action.
          </p>
          <div class="settings-grid">
            <div class="settings-field-span">
              <label class="settings-checkbox">
                <input
                  type="checkbox"
                  checked={voice().streaming ?? true}
                  onChange={(e) => void update({ streaming: e.currentTarget.checked })}
                />
                <span>Periodic captions while recording</span>
              </label>
              <small class="settings-field-hint">
                Short non-overlapping WAV requests every two audio seconds, coalesced up to eight
                seconds when busy. Not a realtime socket or a latency guarantee. If captions fall
                behind or fail, they visibly stop; the full recording still transcribes after Stop.
              </small>
            </div>
            <label class="settings-field-span">
              <span>Method</span>
              <select
                aria-label="Method"
                value={voice().dictationMethod ?? 'native-stt'}
                onChange={(e) =>
                  void update({
                    dictationMethod: e.currentTarget.value as VoicePrefs['dictationMethod'],
                  })
                }
              >
                <option value="native-stt">Native STT</option>
                <option value="audio-context">Audio + context</option>
              </select>
            </label>
            <label class="settings-field-span">
              <span>Model (captions and final)</span>
              <input
                type="text"
                value={
                  editingModel()
                    ? ((audioContext() ? voice().audioContextModel : voice().sttModel) ??
                      sttModel())
                    : sttModel()
                }
                onFocus={() => setEditingModel(true)}
                onInput={(e) =>
                  void update(
                    audioContext()
                      ? { audioContextModel: e.currentTarget.value }
                      : { sttModel: e.currentTarget.value },
                  )
                }
                onBlur={() => {
                  void update(
                    audioContext() ? { audioContextModel: sttModel() } : { sttModel: sttModel() },
                  );
                  setEditingModel(false);
                }}
              />
              <small class="settings-field-hint">
                Exact OpenRouter model id for {methodLabel()}. Blank uses{' '}
                {audioContext() ? 'google/gemini-2.5-flash' : 'mistralai/voxtral-mini-transcribe'}.
                Each method keeps its own saved id; unsupported ids report an error, never a
                fallback.
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
                One phrase per line.{' '}
                {audioContext()
                  ? 'Canonical app handles are added automatically and sent as candidate names with the audio and fixed transcription prompt to /chat/completions.'
                  : 'App handles/names/aliases are added automatically and sent through provider.options.mistral.context_bias to /audio/transcriptions; other upstream providers may ignore these Mistral-specific hints.'}{' '}
                Captions and final use the same method, model and vocabulary snapshot. Accuracy is
                not guaranteed.
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
            One OpenRouter key for Dictate and Read. Saved key sources only; the unsaved key below
            does not change this snapshot. The shared API-key file wins over the manual Settings
            field. Default file: <code>~/.config/agents/.env</code> (CONDASH_AGENTS_ENV may override
            it). Finding a key does not test it with the provider; no provider request is made.
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
                    <p>OpenRouter: {keyDescription(snapshot.keys.openrouter)}</p>
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
          </div>
          <small class="settings-field-hint">
            The manual key is stored in this machine's settings.json and prefilled here. Environment
            key values stay in main.
          </small>
        </fieldset>

        <fieldset class="settings-launcher-fieldset" aria-label="Read aloud">
          <legend>Read aloud</legend>
          <p class="settings-hint" data-test-read-route>
            <strong>Draft route if saved:</strong> OpenRouter only → speech ({ttsModel()}). Uses the
            same OpenRouter key as Dictate. No alternate provider, model or voice fallback on
            missing credentials or errors. This preview does not validate the model, voice or
            credentials.
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
              <small class="settings-field-hint">Exact model id sent to OpenRouter.</small>
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
          </div>
        </fieldset>
        <p class="settings-hint">
          Privacy: periodic caption requests send audio while speaking; final transcription
          continues after Stop releases the mic. No always-on capture or persisted audio. Captions
          are display-only; final text is inserted once after Stop. Actual action stages appear by
          Dictate, not in this Settings preview.
        </p>
      </Show>
    </SectionShell>
  );
}
