# Voice dictation and readback

Push-to-talk dictation and on-demand read-aloud for terminal tabs. Voice is off by
default: enable **Settings → Voice → Enable voice controls (Dictate and Read)** and
save. The controls appear immediately on live terminal tabs. Nothing records or
speaks until you explicitly use a control.

**OpenRouter only:** Dictate and Read share one OpenRouter API key. Missing keys
and provider errors never switch to a direct provider, another model or another
voice. A `mistralai/` model id names a model accessed through OpenRouter; it does
not require Mistral credentials.

## Dictate

- Click **Dictate** to start recording, then click **Stop** to finish. Alternatively,
  hold **Ctrl+Shift+Space** and release to finish. Edit the chord in Settings; an
  empty shortcut disables new push-to-talk gestures.
- The microphone is released before final transcription starts. Only the final
  transcript is inserted into the tab captured at recording start; captions never
  enter the terminal. Control characters are stripped and insertion is capped at
  4,000 characters. Dictation does not press Enter or execute the text.
- Hiding the controls, closing the tab or leaving its surface cancels capture.
  Blur/hidden-document cancellation applies to the held push-to-talk attempt, not
  an unrelated click-started recording. All captured microphone tracks are released.
- The caption strip wraps, grows to at most three rows, and follows the newest
  words. This display wrapping does not insert line breaks into the terminal.

## One OpenRouter model for captions and final text

Dictation requires an **OpenRouter key**, even if a Mistral key is available.
Both provisional captions and the final recording use the exact selected
**OpenRouter native transcription model**. The default is
`mistralai/voxtral-mini-transcribe`. Choose a native STT model, not an audio-input
chat model: existing saved ids are honored unchanged, so a legacy chat id may
return an error. Condash never silently changes that id or tries direct Mistral
dictation or another model when a request fails.

With **Periodic captions while recording** on (the default), main transcribes
short, contiguous, non-overlapping WAVs while you speak. A request starts after
two audio seconds; there is at most one preview request in flight per recording.
Audio arriving while busy coalesces into the next contiguous window, up to eight
seconds. If it exceeds that bound, or a preview fails, captions visibly become
unavailable/interrupted and no further preview requests are admitted. The complete
recording remains available for the final pass. This is periodic transcription,
**not a native realtime WebSocket or an end-to-end latency guarantee**.

Stop aborts outstanding preview work and sends **one complete recording** to the
same selected model, with the same vocabulary. Final text can revise words and
segment boundaries throughout the provisional captions; it is not guaranteed to
change only a few words. Turning captions off disables short requests, not final
transcription. Each captured sample is uploaded at most once for previews and
once for final: at most twice the captured audio, not repeated cumulative prefixes.
Both paths are bounded to a 20 MB WAV; overflow fails explicitly instead of
presenting a transcribed prefix as the full recording.

Network calls run only in main:

```text
POST https://openrouter.ai/api/v1/audio/transcriptions
{ "model": "mistralai/voxtral-mini-transcribe",
  "input_audio": { "data": "<base64 WAV>", "format": "wav" } }
→ { "text": "..." }
```

The recorder requests mono PCM16 at 16 kHz; WAV headers carry the actual capture
rate if the audio backend supplies another rate. Cancellation aborts requests and
late results cannot update captions or insert text. A known final failure reports
that nothing was inserted. If a Stop IPC reply is lost, insertion is **unconfirmed**:
main may already have inserted, so Condash never retries that upload automatically.

## Vocabulary hints

**Context bias — vocabulary** takes one word or phrase per line, up to 100.
Registered app handles, names and aliases are automatically merged with that list;
an empty field does not necessarily mean no effective vocabulary. The effective
list is snapshotted with the model and credentials when the session starts.
If Stop beats the start reply, its buffered-clip upload consumes the same
owner-bound snapshot once rather than reading a newly selected model. Main
retains at most 256 such snapshots (no audio); missing or evicted evidence gives
an explicit error and requires a new recording, never a silent model switch.

Hints travel through OpenRouter's documented provider-specific options mechanism:
`provider.options.mistral.context_bias`, an array of phrases. The default model's
upstream provider tag is `mistral`; this does **not** require a separate Mistral key
or direct-provider call. Other upstream providers may ignore Mistral-specific
hints. Vocabulary improves neither spelling nor quality by guarantee; actual
provider forwarding/effectiveness and quality/latency require a real test.

Contract references checked 2026-10-16: [OpenRouter STT](https://openrouter.ai/docs/guides/overview/multimodal/stt),
[model endpoints](https://openrouter.ai/api/v1/models/mistralai/voxtral-mini-transcribe/endpoints),
and [Mistral context bias field](https://docs.mistral.ai/studio/audio/speech_to_text/offline_transcription).
The Mistral documentation establishes the field shape, not a separate connection.

## Keys and settings

The shared API-key file is read-only, by default `~/.config/agents/.env`;
`CONDASH_AGENTS_ENV` overrides that path. `OPENROUTER_API_KEY` is the only key
resolved for Dictate and Read. Its env-file entry wins over the manual
**Settings → Voice → OpenRouter API key** field. `MISTRAL_API_KEY` is ignored by
Voice. Legacy saved `mistralApiKey` and `mistralVoiceId` values remain accepted
but deprecated and ignored; Condash does not migrate or delete them.

The section groups Dictation, Credentials and Read aloud under the shared enable
switch, with eight active preferences and no Mistral key/voice controls.
**Draft route if saved** reacts to
draft controls; it does not describe a saved/validated setup or actual action.
Saved key-source status shows only presence and source, never validity, and makes
no provider request. Open/Save/Refresh refresh that snapshot; pending/error marks
the previous reading stale. Draft keys do not affect it. Manually entered keys
are stored in machine-local settings and the OpenRouter key is prefilled in its password field; env
key values stay in main. See [the full key reference](../reference/config.md#voice).

Successful insertion reports clear permanently after five seconds, or immediately
when you leave their target tab or column. Success completed while that target is
inactive is not shown on return. Starting, recording, finalizing and error reports
do not expire on this timer.

The session-only report beside Dictate distinguishes recording, observed caption
delivery, OpenRouter native final text and insertion. Successful session start
alone is not evidence that any caption was delivered. Preview failure keeps the
recording for Stop; provider failures are not silently routed elsewhere.

## Read aloud

**Read** synthesizes the tab's recent output, not a parsed final answer. It stays
**Stop** while synthesizing and playing; Stop cancels a pending synthesis or
playback. It never speaks unprompted. The route is OpenRouter `/audio/speech`
only, with no fallback even when legacy Mistral credentials are saved.
Default model `mistralai/voxtral-mini-tts-2603`, OpenRouter
voice `en_paul_neutral`, output MP3. Select a language/persona-compatible voice
for your chosen speech model. The exact selected model and voice are sent to
OpenRouter; rejection reports an error rather than substituting another choice.

## Privacy and limitations

Enabled, explicitly started capture only; no always-on listening or persisted
audio. Caption WAVs leave the machine while recording; final upload/provider
processing continues after Stop releases the microphone. Preview plus final work
can be billed separately. Condash makes no measured accuracy, latency or price
parity claim. Do not dictate sensitive audio or read aloud tabs containing secrets.

Synthetic tests exercise caption-before-Stop, final insertion, owner cancellation,
provider failure and honest non-16-kHz WAV headers without real keys or a native
microphone. They do not establish real provider quality or throughput.
