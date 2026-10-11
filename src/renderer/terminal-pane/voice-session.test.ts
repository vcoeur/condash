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
import type { VoiceAudioClip } from '@shared/types';
import type { VoiceSession } from './voice-session';

interface FakeRecorder {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  active: boolean;
  readonly recording: boolean;
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
});
