/**
 * Lifecycle tests for the voice session controller — the layer the pure
 * recorder/capture modules cannot reach.
 *
 * The review defect this pins: the mic could stay hot with no visible
 * indicator and no stop control, because the controls render only while
 * `activeSid` is set and nothing released the recorder when they disappeared
 * (column switch, Dashboard band, tab close, component disposal). The
 * contract now lives in `createVoiceSession`: a recording cannot outlive the
 * controls — nulling `activeSid` cancels capture in the same flush that
 * hides the buttons, disposal cancels capture and playback, and the insert
 * targets the tab captured at record start.
 *
 * These tests run the real `createVoiceSession` and fake only what it reaches
 * out to: the recorder, the IPC bridge, audio playback and the notice sink.
 * Each test names the fix it pins and must go RED when that fix is reverted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import type { VoiceAudioClip, VoiceSpeakResult, VoiceTranscribeResult } from '@shared/types';
import type { VoiceSession } from './voice-session';
import { dictationReportText, type VoiceDictationReport } from './voice-session';

describe('plain-language dictation report', () => {
  const base: VoiceDictationReport = {
    sid: 'test',
    capture: 'stopped',
    captions: 'live',
    producer: 'openrouter-native',
    insertion: 'inserted',
  };
  it.each([
    [
      {},
      'Text inserted into the tab. Periodic captions were shown; OpenRouter native STT transcribed the full final recording.',
    ],
    [
      { producer: 'openrouter-native' },
      'OpenRouter native STT transcribed the full final recording.',
    ],
    [
      { capture: 'starting', captions: 'pending', producer: 'pending', insertion: 'pending' },
      'Starting the microphone. Live captions have not appeared yet.',
    ],
    [
      { capture: 'recording', producer: 'pending', insertion: 'pending' },
      'Recording — periodic OpenRouter captions are provisional; final text follows Stop.',
    ],
    [
      { capture: 'recording', captions: 'unavailable', producer: 'pending', insertion: 'pending' },
      'Recording — recording continues; transcription follows Stop. Live captions were unavailable;',
    ],
    [
      { capture: 'recording', captions: 'interrupted', producer: 'pending', insertion: 'pending' },
      'Live captions were shown, then interrupted;',
    ],
    [
      { capture: 'recording', captions: 'off', producer: 'pending', insertion: 'pending' },
      'Live captions were off;',
    ],
    [
      { capture: 'recording', captions: 'pending', producer: 'pending', insertion: 'pending' },
      'Live captions have not appeared yet.',
    ],
    [
      { captions: 'not-observed', insertion: 'pending', producer: 'pending' },
      'Recording stopped. Preparing the final transcript. No live captions were observed; The final transcript is pending.',
    ],
    [
      { capture: 'cancelled', insertion: 'none', producer: 'none' },
      'Recording cancelled. Nothing inserted.',
    ],
    [
      { capture: 'failed', insertion: 'none', producer: 'none' },
      'Recording failed. Nothing inserted.',
    ],
    [{ insertion: 'none', producer: 'none' }, 'Recording stopped. Nothing inserted.'],
    [
      { insertion: 'unknown', producer: 'unknown', reason: 'Safe error detail' },
      'Insertion unconfirmed. Periodic captions were shown; The final transcript source is unknown. — Safe error detail',
    ],
  ] as [Partial<VoiceDictationReport>, string][])(
    'preserves observed facts for %j',
    (patch, expected) => {
      const text = dictationReportText({ ...base, ...patch });
      expect(text).toContain(expected);
      if (patch.insertion === 'unknown') expect(text).not.toMatch(/Nothing inserted|retry/i);
    },
  );
});

interface FakeRecorder {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  active: boolean;
  readonly recording: boolean;
  capturedRate: number;
}

function makeFakeRecorder(): FakeRecorder {
  const rec = {
    start: vi.fn(async () => {
      rec.active = true;
    }),
    stop: vi.fn(async (): Promise<VoiceAudioClip | null> => {
      rec.active = false;
      return { data: 'a2xpcA==', sampleRate: 16000, format: 'wav' };
    }),
    cancel: vi.fn(() => {
      rec.active = false;
    }),
    active: false,
    get recording(): boolean {
      return rec.active;
    },
    capturedRate: 16000,
  };
  return rec;
}

interface FakeAudio {
  src: string;
  pausedCalls: number;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

function makeFakeAudio(src: string): FakeAudio {
  const audio: FakeAudio = {
    src,
    pausedCalls: 0,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(() => {
      audio.pausedCalls += 1;
    }),
    onended: null,
  };
  return audio;
}

interface Harness {
  session: VoiceSession;
  recorder: FakeRecorder;
  notices: string[];
  transcribe: ReturnType<typeof vi.fn>;
  speak: ReturnType<typeof vi.fn>;
  audios: FakeAudio[];
  setActiveSid(sid: string | null): void;
  dispose(): void;
}

async function createHarness(): Promise<Harness> {
  // A fresh module graph per harness: voice-session holds one module-scope
  // playback element shared across panes, so resetting the cache keeps every
  // test on a clean owner.
  vi.resetModules();
  const { createVoiceSession } = await import('./voice-session');

  const recorder = makeFakeRecorder();
  const notices: string[] = [];
  const audios: FakeAudio[] = [];
  const transcribe = vi.fn(async () => ({ inserted: true, chars: 5 }));
  const speak = vi.fn(async () => ({ ok: true, mime: 'audio/mpeg', audioBase64: 'QQ==' }));
  const [activeSid, setActiveSid] = createSignal<string | null>('a');

  let session!: VoiceSession;
  const dispose = createRoot((disposeRoot) => {
    session = createVoiceSession({
      activeSid,
      onNotice: (message) => notices.push(message),
      recorder,
      transcribe,
      speak,
      createAudio: (src) => {
        const audio = makeFakeAudio(src);
        audios.push(audio);
        return audio;
      },
    });
    return disposeRoot;
  });

  return Promise.resolve({
    session,
    recorder,
    notices,
    transcribe,
    speak,
    audios,
    setActiveSid,
    dispose,
  });
}

describe('voice session lifecycle', () => {
  let h!: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(() => {
    h.dispose();
    vi.useRealTimers();
  });

  it('expires success at five seconds and gives each new success its own deadline', async () => {
    vi.useFakeTimers();
    await h.session.startDictation();
    await h.session.stopDictation();
    vi.advanceTimersByTime(4999);
    expect(h.session.report()?.insertion).toBe('inserted');
    vi.advanceTimersByTime(1);
    expect(h.session.report()).toBeNull();
    await h.session.startDictation();
    await h.session.stopDictation();
    vi.advanceTimersByTime(4999);
    expect(h.session.report()?.insertion).toBe('inserted');
    vi.advanceTimersByTime(1);
    expect(h.session.report()).toBeNull();
  });

  it.each(['b', null])('permanently clears success on departure to %s', async (target) => {
    vi.useFakeTimers();
    await h.session.startDictation();
    await h.session.stopDictation();
    h.setActiveSid(target);
    expect(h.session.report()).toBeNull();
    h.setActiveSid('a');
    expect(h.session.report()).toBeNull();
    vi.advanceTimersByTime(5000);
    h.setActiveSid(target);
    h.setActiveSid('a');
    expect(h.session.report()).toBeNull();
  });

  it('does not present success completed while its target is inactive', async () => {
    let finish!: (result: VoiceTranscribeResult) => void;
    h.transcribe.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await h.session.startDictation();
    const stopping = h.session.stopDictation();
    await Promise.resolve();
    h.setActiveSid('b');
    finish({ inserted: true, chars: 5 });
    await stopping;
    h.setActiveSid('a');
    expect(h.session.report()).toBeNull();
  });

  it('never expires recording, pending or unknown errors, including after an old success', async () => {
    vi.useFakeTimers();
    await h.session.startDictation();
    await h.session.stopDictation();
    await h.session.startDictation();
    vi.advanceTimersByTime(5000);
    expect(h.session.report()?.capture).toBe('recording');
    let fail!: (error: Error) => void;
    h.transcribe.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
    const stopping = h.session.stopDictation();
    await Promise.resolve();
    vi.advanceTimersByTime(5000);
    expect(h.session.report()?.insertion).toBe('pending');
    fail(new Error('Synthetic failure'));
    await stopping;
    vi.advanceTimersByTime(5000);
    expect(h.session.report()?.insertion).toBe('unknown');
  });

  it('cleans the success timeout on disposal', async () => {
    vi.useFakeTimers();
    await h.session.startDictation();
    await h.session.stopDictation();
    expect(vi.getTimerCount()).toBe(1);
    h.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps starting and known failures visible without a timeout', async () => {
    vi.useFakeTimers();
    let rejectStart!: (error: Error) => void;
    h.recorder.start.mockImplementation(
      () => new Promise((_resolve, reject) => (rejectStart = reject)),
    );
    const starting = h.session.startDictation();
    vi.advanceTimersByTime(5000);
    expect(h.session.report()?.capture).toBe('starting');
    rejectStart(new Error('Synthetic microphone failure'));
    await starting;
    vi.advanceTimersByTime(5000);
    expect(h.session.report()?.capture).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels capture when activeSid nulls mid-recording (the mic may never outlive the controls)', async () => {
    await h.session.toggleDictation();
    expect(h.session.recording()).toBe(true);
    expect(h.recorder.recording).toBe(true);

    // Column switch / Dashboard band / tab close — the buttons unmount. The
    // release must be synchronous with the state change, not eventual.
    h.setActiveSid(null);

    expect(h.recorder.cancel).toHaveBeenCalledTimes(1);
    expect(h.recorder.recording).toBe(false);
    expect(h.session.recording()).toBe(false);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatch(/Recording cancelled/);
  });

  it('cancels capture and playback on disposal (column unmount, conception switch)', async () => {
    await h.session.toggleDictation();
    expect(h.session.recording()).toBe(true);

    h.dispose();

    expect(h.recorder.cancel).toHaveBeenCalledTimes(1);
    expect(h.recorder.recording).toBe(false);
    expect(h.notices).toHaveLength(0);
  });

  it('stops playback of a read on disposal, not just capture', async () => {
    await h.session.readAloud();
    expect(h.session.speaking()).toBe(true);
    expect(h.audios).toHaveLength(1);

    h.dispose();

    expect(h.audios[0].pausedCalls).toBe(1);
  });

  it('cancels on disposal even while start() is still pending', async () => {
    let releaseStart!: () => void;
    h.recorder.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );

    const toggling = h.session.toggleDictation();
    h.dispose();
    releaseStart();
    await toggling;

    // Cleanup ran before the mic opened, so the post-start guard cancels a
    // second time — release() is idempotent, and the outcome is what matters:
    // no track left open once the toggle settles.
    expect(h.recorder.cancel).toHaveBeenCalled();
    expect(h.recorder.recording).toBe(false);
    expect(h.session.recording()).toBe(false);
  });

  it('cancels when the tab goes away while the mic prompt was pending', async () => {
    let releaseStart!: () => void;
    h.recorder.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );

    const toggling = h.session.toggleDictation();
    h.setActiveSid(null);
    releaseStart();
    await toggling;

    expect(h.recorder.cancel).toHaveBeenCalledTimes(1);
    expect(h.recorder.recording).toBe(false);
    expect(h.session.recording()).toBe(false);
    expect(h.notices).toHaveLength(1);
  });

  it('inserts into the tab captured at record start, not the one active at stop', async () => {
    await h.session.toggleDictation();
    expect(h.session.recording()).toBe(true);

    // Switching to another live tab of the same column keeps activeSid set,
    // so the recording continues — but the insert must not retarget.
    h.setActiveSid('b');
    await h.session.toggleDictation();

    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.transcribe).toHaveBeenCalledWith('a', {
      data: 'a2xpcA==',
      sampleRate: 16000,
      format: 'wav',
    });
    expect(h.notices).toEqual(['Dictated 5 characters into the tab.']);
  });

  it('releases the mic on a plain stop and reports a dead tab instead of inserting', async () => {
    await h.session.toggleDictation();
    h.setActiveSid('b');
    h.transcribe.mockResolvedValueOnce({ inserted: false, reason: 'no-session' });
    await h.session.toggleDictation();

    expect(h.recorder.stop).toHaveBeenCalledTimes(1);
    expect(h.recorder.recording).toBe(false);
    expect(h.notices).toEqual(['That tab is gone — nothing was typed.']);
  });

  it('surfaces a specific notice when main refuses the clip as disabled', async () => {
    // Stale-controls defence: voice was switched off in Settings while a
    // recording was in flight. The IPC gate answers `disabled` without any
    // provider call; the pane must say so rather than read as a silent no-op.
    await h.session.toggleDictation();
    h.transcribe.mockResolvedValueOnce({ inserted: false, reason: 'disabled' });
    await h.session.toggleDictation();

    expect(h.recorder.stop).toHaveBeenCalledTimes(1);
    expect(h.recorder.recording).toBe(false);
    expect(h.notices).toEqual(['Voice is disabled — enable it in Settings → Voice.']);
  });

  it('keeps one shared playback element across panes: a second read stops the first', async () => {
    // Two columns = two sessions over the one module graph, so the shared
    // `currentAudio` owner the controls used to hold is preserved.
    const { createVoiceSession } = await import('./voice-session');
    let sessionB!: VoiceSession;
    const disposeB = createRoot((disposeRoot) => {
      sessionB = createVoiceSession({
        activeSid: () => 'b',
        onNotice: () => undefined,
        recorder: makeFakeRecorder(),
        transcribe: vi.fn(),
        speak: h.speak,
        createAudio: (src) => {
          const audio = makeFakeAudio(src);
          h.audios.push(audio);
          return audio;
        },
      });
      return disposeRoot;
    });

    await h.session.readAloud();
    await sessionB.readAloud();

    expect(h.audios).toHaveLength(2);
    expect(h.audios[0].pausedCalls).toBe(1);
    expect(h.audios[1].pausedCalls).toBe(0);

    // B's disposal stops B's playback (same release contract as pane A's).
    disposeB();
    expect(h.audios[1].pausedCalls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Read-aloud control (the click looked dead: `speaking` went true for the
  // whole provider round-trip, Stop could not cancel the pending synthesis,
  // and a late result played anyway). The attempt token drops a cancelled
  // result; `synthesizing` is the in-flight signal the button binds to.
  // -------------------------------------------------------------------------

  it('drops a late synthesis result after Stop — the cancelled read never creates audio', async () => {
    let releaseSpeak!: (value: VoiceSpeakResult) => void;
    h.speak.mockImplementationOnce(
      () =>
        new Promise<VoiceSpeakResult>((resolve) => {
          releaseSpeak = resolve;
        }),
    );

    const reading = h.session.readAloud();
    expect(h.session.synthesizing()).toBe(true);
    expect(h.session.speaking()).toBe(false);
    expect(h.session.busy()).toBe(true);

    // A click while synthesis is in flight is Stop, not a second read.
    await h.session.readAloud();
    expect(h.session.synthesizing()).toBe(false);
    expect(h.session.speaking()).toBe(false);
    expect(h.session.busy()).toBe(false);

    releaseSpeak({ ok: true, mime: 'audio/mpeg', audioBase64: 'QQ==' });
    await reading;

    expect(h.speak).toHaveBeenCalledTimes(1);
    expect(h.audios).toHaveLength(0);
    expect(h.session.speaking()).toBe(false);
    expect(h.notices).toHaveLength(0);
  });

  it('drops a late synthesis result after disposal', async () => {
    let releaseSpeak!: (value: VoiceSpeakResult) => void;
    h.speak.mockImplementationOnce(
      () =>
        new Promise<VoiceSpeakResult>((resolve) => {
          releaseSpeak = resolve;
        }),
    );

    const reading = h.session.readAloud();
    expect(h.session.synthesizing()).toBe(true);

    h.dispose();
    expect(h.session.synthesizing()).toBe(false);
    expect(h.session.speaking()).toBe(false);

    releaseSpeak({ ok: true, mime: 'audio/mpeg', audioBase64: 'QQ==' });
    await reading;

    expect(h.audios).toHaveLength(0);
  });

  it('resets synthesizing and speaking and notices when synthesis reports ok:false', async () => {
    h.speak.mockResolvedValueOnce({ ok: false, error: 'No recent output in this tab.' });

    await h.session.readAloud();

    expect(h.session.synthesizing()).toBe(false);
    expect(h.session.speaking()).toBe(false);
    expect(h.session.busy()).toBe(false);
    expect(h.audios).toHaveLength(0);
    expect(h.notices).toEqual(['No recent output in this tab.']);
  });

  it('resets synthesizing and speaking and notices when synthesis throws', async () => {
    h.speak.mockRejectedValueOnce(new Error('socket exploded'));

    await h.session.readAloud();

    expect(h.session.synthesizing()).toBe(false);
    expect(h.session.speaking()).toBe(false);
    expect(h.session.busy()).toBe(false);
    expect(h.audios).toHaveLength(0);
    expect(h.notices).toEqual(['Read-aloud failed: socket exploded']);
  });

  it('does not start a read while dictation is capturing (mutual exclusion)', async () => {
    await h.session.toggleDictation();
    expect(h.session.recording()).toBe(true);

    await h.session.readAloud();

    expect(h.speak).not.toHaveBeenCalled();
    expect(h.session.synthesizing()).toBe(false);
    expect(h.session.speaking()).toBe(false);
    expect(h.audios).toHaveLength(0);
  });

  it('does not start dictation while a read is synthesizing (mutual exclusion)', async () => {
    let releaseSpeak!: (value: VoiceSpeakResult) => void;
    h.speak.mockImplementationOnce(
      () =>
        new Promise<VoiceSpeakResult>((resolve) => {
          releaseSpeak = resolve;
        }),
    );

    const reading = h.session.readAloud();
    expect(h.session.synthesizing()).toBe(true);

    await h.session.startDictation();

    expect(h.recorder.start).not.toHaveBeenCalled();
    expect(h.session.recording()).toBe(false);

    releaseSpeak({ ok: false, error: 'cancelled' });
    await reading;
  });

  it('cancels a read that is still synthesizing when the tab is no longer active', async () => {
    let releaseSpeak!: (value: VoiceSpeakResult) => void;
    h.speak.mockImplementationOnce(
      () =>
        new Promise<VoiceSpeakResult>((resolve) => {
          releaseSpeak = resolve;
        }),
    );

    const reading = h.session.readAloud();
    expect(h.session.synthesizing()).toBe(true);

    // Column switch / Dashboard band hides the Read/Stop control; the pending
    // synthesis must not play into a pane that can no longer stop it. No toast.
    h.setActiveSid(null);
    expect(h.session.synthesizing()).toBe(false);

    releaseSpeak({ ok: true, mime: 'audio/mpeg', audioBase64: 'QQ==' });
    await reading;

    expect(h.audios).toHaveLength(0);
    expect(h.session.speaking()).toBe(false);
    expect(h.notices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Streaming extensions (design note 04 §5, §10) — the same controller over
// the realtime edge. The eight tests above are the batch contract; these pin
// the streaming upgrade: partials update the caption signal, a stream commit
// answers through the same notice branches, and every stream failure falls
// back to the buffered-clip batch chain verbatim.
// ---------------------------------------------------------------------------

interface FakeStreamEdge {
  start: ReturnType<typeof vi.fn>;
  audio: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  onPartial: ReturnType<typeof vi.fn>;
  emitPartial: (msg: { sid: string; text: string }) => void;
}

function makeFakeStreamEdge(): FakeStreamEdge {
  const callbacks: ((msg: { sid: string; text: string }) => void)[] = [];
  let ownerId = '';
  return {
    start: vi.fn(async (_sid: string, owner: string) => {
      ownerId = owner;
      return { ok: true };
    }),
    audio: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({ inserted: true, provider: 'openrouter', chars: 6 })),
    cancel: vi.fn(async () => undefined),
    onPartial: vi.fn((cb: (msg: { sid: string; text: string }) => void) => {
      callbacks.push(cb);
      return () => undefined;
    }),
    emitPartial: (msg) => {
      for (const cb of callbacks) cb({ ...msg, ownerId } as typeof msg);
    },
  };
}

interface StreamHarness extends Omit<Harness, 'deps'> {
  stream: FakeStreamEdge;
  session: VoiceSession;
}

async function createStreamHarness(
  overrides: {
    startResult?: { ok: boolean; reason?: string };
    stopResult?: VoiceTranscribeResult;
    stopThrows?: boolean;
  } = {},
): Promise<StreamHarness> {
  vi.resetModules();
  const { createVoiceSession } = await import('./voice-session');
  const recorder = makeFakeRecorder();
  const notices: string[] = [];
  const audios: FakeAudio[] = [];
  const transcribe = vi.fn(async () => ({ inserted: true, chars: 5 }));
  const speak = vi.fn(async () => ({ ok: true, mime: 'audio/mpeg', audioBase64: 'QQ==' }));
  const stream = makeFakeStreamEdge();
  if (overrides.startResult) stream.start.mockResolvedValue(overrides.startResult);
  if (overrides.stopThrows) stream.stop.mockRejectedValue(new Error('socket exploded'));
  else
    stream.stop.mockResolvedValue(
      overrides.stopResult ?? { inserted: true, provider: 'openrouter', chars: 6 },
    );
  const [activeSid, setActiveSid] = createSignal<string | null>('a');
  let session!: VoiceSession;
  const dispose = createRoot((disposeRoot) => {
    session = createVoiceSession({
      activeSid,
      onNotice: (message) => notices.push(message),
      recorder,
      transcribe,
      speak,
      createAudio: (src) => {
        const audio = makeFakeAudio(src);
        audios.push(audio);
        return audio;
      },
      stream,
    });
    return disposeRoot;
  });
  return {
    session,
    recorder,
    notices,
    transcribe,
    speak,
    audios,
    setActiveSid,
    dispose,
    stream,
  };
}

describe('voice session streaming', () => {
  it('reports live captions independently from a batch final producer', async () => {
    const h = await createStreamHarness({
      stopResult: {
        inserted: true,
        provider: 'openrouter',
        producer: 'openrouter-native',
        chars: 8,
      },
    });
    await h.session.startDictation();
    expect(h.session.report()).toMatchObject({
      capture: 'recording',
      captions: 'pending',
      producer: 'pending',
    });
    h.stream.emitPartial({ sid: 'a', text: 'live text' });
    await h.session.stopDictation();
    expect(h.session.report()).toMatchObject({
      capture: 'stopped',
      captions: 'live',
      producer: 'openrouter-native',
      insertion: 'inserted',
    });
    expect(h.transcribe).not.toHaveBeenCalled();
    h.dispose();
  });

  it('never infers realtime from provider alone or live captions from start success', async () => {
    const h = await createStreamHarness();
    await h.session.startDictation();
    await h.session.stopDictation();
    expect(h.session.report()).toMatchObject({
      captions: 'not-observed',
      producer: 'unknown',
      insertion: 'inserted',
    });
    h.dispose();
  });

  it('reports interrupted captions on owned failure events and ignores foreign/stale events', async () => {
    const h = await createStreamHarness();
    await h.session.startDictation();
    const ownerId = h.stream.start.mock.calls[0][1];
    const receive = h.stream.onPartial.mock.calls[0][0];
    receive({ ownerId: 'foreign', sid: 'a', text: '', unavailable: true });
    expect(h.session.report()?.captions).toBe('pending');
    h.stream.emitPartial({ sid: 'a', text: 'words' });
    receive({ ownerId, sid: 'a', text: '', unavailable: true });
    expect(h.session.report()?.captions).toBe('interrupted');
    await h.session.stopDictation();
    await h.session.startDictation();
    receive({ ownerId, sid: 'a', text: 'old', unavailable: true });
    expect(h.session.report()).toMatchObject({ captions: 'pending', producer: 'pending' });
    h.dispose();
  });

  it('keeps unknown insertion after rejected Stop, and rejects a stale prior result', async () => {
    const h = await createStreamHarness({ stopThrows: true });
    await h.session.startDictation();
    await h.session.stopDictation();
    expect(h.session.report()).toMatchObject({ producer: 'unknown', insertion: 'unknown' });
    expect(h.transcribe).not.toHaveBeenCalled();
    let resolve!: (result: VoiceTranscribeResult) => void;
    h.stream.stop.mockImplementationOnce(
      () =>
        new Promise<VoiceTranscribeResult>((done) => {
          resolve = done;
        }),
    );
    await h.session.startDictation();
    const stopping = h.session.stopDictation();
    await Promise.resolve();
    await Promise.resolve();
    await h.session.startDictation();
    resolve({ inserted: true, producer: 'openrouter-native', chars: 4 });
    await stopping;
    expect(h.session.report()).toMatchObject({
      capture: 'recording',
      producer: 'pending',
      insertion: 'pending',
    });
    h.dispose();
  });

  it('streams while recording: partials update the caption signal and clear on stop', async () => {
    const h = await createStreamHarness();
    await h.session.toggleDictation();
    expect(h.stream.start).toHaveBeenCalledWith('a', expect.any(String));
    // The caption signal holds '' while the stream is live (strip mounted,
    // nothing said yet).
    expect(h.session.partial()).toBe('');
    h.stream.emitPartial({ sid: 'a', text: 'hello worl' });
    h.stream.emitPartial({ sid: 'a', text: 'hello world' });
    expect(h.session.partial()).toBe('hello world');

    await h.session.toggleDictation();
    expect(h.stream.stop).toHaveBeenCalledTimes(1);
    expect(h.session.partial()).toBeNull();
    expect(h.notices).toEqual(['Dictated 6 characters into the tab.']);
    h.dispose();
  });

  it('ignores partials for another session and after the stream ended', async () => {
    const h = await createStreamHarness();
    await h.session.toggleDictation();
    h.stream.emitPartial({ sid: 'other', text: 'not mine' });
    expect(h.session.partial()).toBe('');
    await h.session.toggleDictation();
    h.stream.emitPartial({ sid: 'a', text: 'late' });
    expect(h.session.partial()).toBeNull();
    h.dispose();
  });

  it('keeps recording and reports unavailable captions when main refuses the stream start', async () => {
    const h = await createStreamHarness({
      startResult: { ok: false, reason: 'no-openrouter-key' },
    });
    await h.session.toggleDictation();
    expect(h.session.recording()).toBe(true);
    expect(h.session.partial()).toBeNull();
    expect(h.notices).toEqual([
      'Live captions unavailable — recording continues for transcription after Stop.',
    ]);
    // Stop commits through the buffered-clip batch chain.
    await h.session.toggleDictation();
    expect(h.stream.stop).not.toHaveBeenCalled();
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it('does not retarget or re-upload an accepted session after it is gone', async () => {
    const h = await createStreamHarness({ stopResult: { inserted: false, reason: 'no-session' } });
    await h.session.toggleDictation();
    h.stream.emitPartial({ sid: 'a', text: 'partial text' });
    await h.session.toggleDictation();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.notices).toEqual(['That tab is gone — nothing was typed.']);
    expect(h.session.partial()).toBeNull();
    h.dispose();
  });

  it('does not duplicate a possibly committed stream when the stop reply throws', async () => {
    const h = await createStreamHarness({ stopThrows: true });
    await h.session.toggleDictation();
    await h.session.toggleDictation();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.notices).toEqual(['socket exploded']);
    h.dispose();
  });

  it('releases the stream on an activeSid null exactly like the recorder cancel', async () => {
    const h = await createStreamHarness();
    await h.session.toggleDictation();
    expect(h.session.recording()).toBe(true);

    h.setActiveSid(null);

    expect(h.stream.cancel).toHaveBeenCalledTimes(1);
    expect(h.recorder.cancel).toHaveBeenCalledTimes(1);
    expect(h.session.partial()).toBeNull();
    expect(h.notices).toHaveLength(1);
    h.dispose();
  });

  it('releases the stream on disposal (column unmount, conception switch)', async () => {
    const h = await createStreamHarness();
    await h.session.toggleDictation();
    h.dispose();
    expect(h.stream.cancel).toHaveBeenCalledTimes(1);
  });

  it('never sends stream chunks once the stream is no longer live', async () => {
    // The recorder tap is gated on the caption signal at the controls layer;
    // here we pin the session-side half: after a refused start the session
    // never enters streaming state, so the stream edge stays untouched.
    const h = await createStreamHarness({ startResult: { ok: false, reason: 'disabled' } });
    await h.session.toggleDictation();
    expect(h.stream.audio).not.toHaveBeenCalled();
    h.dispose();
  });

  it('reports an accurate notice when the stream start rejects — not a mic error', async () => {
    // NIT-4 (note 06): a voiceStreamStart IPC rejection (e.g. a corrupt
    // conception config thrown while resolving the bias list) used to map
    // through micErrorMessage and surface as "Could not open the
    // microphone." while the mic was in fact open and recording on batch.
    const h = await createStreamHarness();
    h.stream.start.mockRejectedValueOnce(new Error('config parse failed'));
    await h.session.toggleDictation();
    expect(h.session.recording()).toBe(true);
    expect(h.notices).toEqual([
      'Live captions unavailable — recording continues for transcription after Stop.',
    ]);
    // The recording continues; the commit runs the buffered-clip batch chain.
    await h.session.toggleDictation();
    expect(h.stream.stop).not.toHaveBeenCalled();
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    h.dispose();
  });
});
