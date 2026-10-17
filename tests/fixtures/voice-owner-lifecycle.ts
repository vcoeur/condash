import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRoot, createSignal } from 'solid-js';
import { createVoiceRecorder } from '../../src/renderer/terminal-pane/voice-recorder';
import { createVoiceSession } from '../../src/renderer/terminal-pane/voice-session';
import { createGlobalKeyboard } from '../../src/renderer/global-keyboard';
import { registerVoicePtt } from '../../src/renderer/terminal-pane/voice-ptt-registry';
import {
  beginVoiceStream,
  cancelActiveVoiceStream,
  getActiveVoiceStream,
  takeActiveVoiceStream,
  reserveVoiceStream,
  ownsVoiceStream,
  releaseVoiceStream,
  MAX_PRESTART_CANCELLATIONS,
} from '../../src/main/voice/stream';
import { insertTranscript } from '../../src/main/voice/insert';
import { transcribeClip } from '../../src/main/voice/adapter';
import type { VoicePartialMessage } from '../../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// An explicitly delayed IPC setup reply and fake native transcription fetch.
// The historical scenario driver uses emit('open') to release that setup gate;
// no socket is constructed by the production dictation code.
class FakeSocket {
  handlers: Record<string, ((...args: any[]) => void)[]> = {};
  sent: (string | Buffer)[] = [];
  closed = false;
  caption = 'stream transcript';
  readonly ready = deferred<void>();
  onCaption = (_text: string) => {};
  on(event: string, callback: (...args: any[]) => void) {
    (this.handlers[event] ??= []).push(callback);
  }
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  terminate() {
    this.closed = true;
  }
  emit(event: string, ...args: unknown[]) {
    if (event === 'open') this.ready.resolve();
    if (event === 'message') {
      const message = JSON.parse(String(args[0]));
      if (message.text) this.caption = message.text;
    }
    for (const callback of this.handlers[event] ?? []) callback(...args);
  }
  text(text: string) {
    this.caption = text;
    this.onCaption(text);
    this.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'transcription.text.delta', text })),
      false,
    );
  }
}

class FakeNode {
  disconnected = false;
  gain = { value: 1 };
  onaudioprocess: ((event: any) => void) | null = null;
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
}

function mediaEdges() {
  const acquisitions: ReturnType<typeof deferred<MediaStream>>[] = [];
  const tracks: { stopped: number }[] = [];
  const contexts: FakeContext[] = [];
  let failGraph = false;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  function install(name: string, value: unknown) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  class FakeContext {
    sampleRate = 16000;
    closed = false;
    destination = {};
    processor = new FakeNode();
    source = new FakeNode();
    sink = new FakeNode();
    constructor() {
      contexts.push(this);
    }
    createMediaStreamSource() {
      return this.source;
    }
    createScriptProcessor() {
      if (failGraph) throw new Error('graph setup failed');
      return this.processor;
    }
    createGain() {
      return this.sink;
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  install('navigator', {
    mediaDevices: {
      getUserMedia: () => {
        const acquisition = deferred<MediaStream>();
        acquisitions.push(acquisition);
        return acquisition.promise;
      },
    },
  });
  install('AudioContext', FakeContext);
  const listeners: Record<string, ((event: KeyboardEvent) => void)[]> = {};
  install('document', {
    addEventListener(type: string, listener: (event: KeyboardEvent) => void) {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener(type: string, listener: (event: KeyboardEvent) => void) {
      listeners[type] = listeners[type].filter((entry) => entry !== listener);
    },
  });
  const windowListeners: Record<string, (() => void)[]> = {};
  install('window', {
    addEventListener(type: string, listener: () => void) {
      (windowListeners[type] ??= []).push(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      windowListeners[type] = windowListeners[type].filter((entry) => entry !== listener);
    },
  });
  return {
    acquisitions,
    tracks,
    contexts,
    listeners,
    blur: () => windowListeners.blur?.forEach((listener) => listener()),
    hide: () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      listeners.visibilitychange?.forEach((listener) => listener({} as KeyboardEvent));
    },
    failGraph: () => {
      failGraph = true;
    },
    resolve(index: number) {
      const track = { stopped: 0 };
      tracks[index] = track;
      acquisitions[index].resolve({
        getTracks: () => [
          {
            stop: () => {
              track.stopped++;
            },
          },
        ],
      } as unknown as MediaStream);
    },
    chunk(index: number) {
      contexts[index].processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) },
      });
    },
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

function column(media: ReturnType<typeof mediaEdges>, sid = 'target-tab') {
  const sockets: FakeSocket[] = [];
  const owners: string[] = [];
  const writes: { sid: string; text: string }[] = [];
  const notices: string[] = [];
  const callbacks: ((message: VoicePartialMessage) => void)[] = [];
  const batchCalls: string[] = [];
  const batchDone: ReturnType<typeof deferred<void>>[] = [];
  let holdBatch = false;
  let duringBatch = () => {};
  let startReplyGate: ReturnType<typeof deferred<void>> | null = null;
  let startOutcome: 'normal' | 'refused' | 'rejected' = 'normal';
  let cancellationFailure: 'none' | 'before-delivery' | 'after-delivery' | 'always' = 'none';
  const cancellations: string[] = [];
  const [activeSid, setActiveSid] = createSignal<string | null>(sid);
  const [activeColumn, setActiveColumn] = createSignal(true);
  const recorder = createVoiceRecorder({
    onChunk: (ownerId, pcm) => session.handleAudio(ownerId, pcm),
  });
  let session!: ReturnType<typeof createVoiceSession>;
  let unregister!: () => void;
  const dispose = createRoot((cleanup) => {
    session = createVoiceSession({
      activeSid,
      recorder,
      onNotice: (message) => notices.push(message),
      transcribe: async (target) => {
        assert.equal(recorder.recording, false, 'microphone released before batch provider work');
        batchCalls.push(target);
        duringBatch();
        if (holdBatch) {
          const gate = deferred<void>();
          batchDone.push(gate);
          await gate.promise;
        }
        writes.push({ sid: target, text: 'batch transcript' });
        return { inserted: true, chars: 16 };
      },
      speak: async () => ({ ok: false }),
      createAudio: () => ({ pause() {}, play: async () => {}, onended: null }),
      stream: {
        start: async (target, ownerId) => {
          owners.push(ownerId);
          const replyGate = startReplyGate;
          if (startOutcome === 'refused' || startOutcome === 'rejected') {
            const admitted = reserveVoiceStream(ownerId);
            assert.ok(admitted.ok);
            releaseVoiceStream(admitted.reservation);
            if (replyGate) await replyGate.promise;
            if (startOutcome === 'rejected') throw new Error('start settings rejected');
            return { ok: false, reason: 'error' };
          }
          const socket = new FakeSocket();
          sockets.push(socket);
          const admitted = reserveVoiceStream(ownerId);
          if (!admitted.ok) return admitted;
          const result = await beginVoiceStream(
            {
              ownerId,
              sid: target,
              transcribe: (clip, signal) =>
                transcribeClip(clip, { openrouter: 'DUMMY' }, undefined, {
                  signal,
                  fetch: async (url) => {
                    assert.equal(url, 'https://openrouter.ai/api/v1/audio/transcriptions');
                    return new Response(JSON.stringify({ text: socket.caption }));
                  },
                }),
              onPartial: (text) =>
                callbacks.forEach((callback) => callback({ ownerId, sid: target, text })),
              insert: (targetSid, text) =>
                insertTranscript(targetSid, text, {
                  isLive: () => true,
                  write: (targetSid, text) => writes.push({ sid: targetSid, text }),
                }),
            },
            admitted.reservation,
          );
          socket.onCaption = (text) => {
            if (getActiveVoiceStream(ownerId))
              callbacks.forEach((callback) => callback({ ownerId, sid: target, text }));
          };
          await socket.ready.promise;
          if (replyGate) await replyGate.promise;
          return result;
        },
        audio: async ({ ownerId, pcmBase64 }) => {
          const socket = sockets[owners.indexOf(ownerId)];
          if (getActiveVoiceStream(ownerId)) socket?.sent.push(Buffer.from(pcmBase64, 'base64'));
          getActiveVoiceStream(ownerId)?.handleAudio(pcmBase64);
        },
        stop: async (ownerId) =>
          takeActiveVoiceStream(ownerId)?.stop() ?? { inserted: false, reason: 'no-session' },
        cancel: async (ownerId) => {
          cancellations.push(ownerId);
          const failure = cancellationFailure;
          if (failure !== 'always') cancellationFailure = 'none';
          if (failure === 'before-delivery' || failure === 'always')
            throw new Error('cancel transport rejected');
          cancelActiveVoiceStream(ownerId);
          const socket = sockets[owners.indexOf(ownerId)];
          if (socket) {
            socket.closed = true;
            socket.ready.resolve();
          }
          if (failure === 'after-delivery') throw new Error('cancel reply rejected');
        },
        onPartial: (callback) => {
          callbacks.push(callback);
          return () => {
            callbacks.splice(callbacks.indexOf(callback), 1);
          };
        },
      },
    });
    unregister = registerVoicePtt({
      isActiveColumn: activeColumn,
      isRecording: session.capturing,
      acquire: session.acquireDictation,
    });
    return cleanup;
  });
  return {
    session,
    recorder,
    sockets,
    owners,
    writes,
    notices,
    callbacks,
    batchCalls,
    cancellations,
    delayReply: (outcome: typeof startOutcome = 'normal') => {
      startOutcome = outcome;
      startReplyGate = deferred<void>();
      return () => startReplyGate!.resolve();
    },
    failCancellation: (failure: typeof cancellationFailure) => {
      cancellationFailure = failure;
    },
    setActiveSid,
    setActiveColumn,
    holdBatch: () => {
      holdBatch = true;
    },
    finishBatch: (index = 0) => batchDone[index].resolve(),
    onBatch: (callback: () => void) => {
      duringBatch = callback;
    },
    dispose: () => {
      unregister();
      dispose();
    },
  };
}

const flush = async () => {
  for (let index = 0; index < 24; index++) await Promise.resolve();
};

export const triggerOwnershipScenarios = [
  'unpaired Space during click recording',
  'unpaired letter during click recording',
  'unpaired Space during pending click',
  'paired pending microphone release',
  'paired established release after modifiers',
  'chord over parked click recording',
  'held repeats across active column change',
  'repeat without physical press',
  'old click-stopped lease then same-column restart',
  'old tab-cancelled lease then same-column restart',
  'old pending lease then inverse microphone restart',
  'old disposed lease then cross-column restart',
  'shortcut changed while held',
  'shortcut disabled while held',
  'blur cancels held recording without commit',
  'blur cancels held pending microphone',
  'hidden document cancels held recording',
  'cleanup cancels held recording without commit',
  'blur leaves unrelated click recording alone',
  'cleanup leaves unrelated click recording alone',
  'blur leaves replacement recording alone',
  'cleanup leaves replacement recording alone',
  'duplicate and reentrant keyup commits once',
] as const;

export async function exerciseTriggerOwnership(
  name: (typeof triggerOwnershipScenarios)[number],
): Promise<void> {
  const media = mediaEdges();
  const columns: ReturnType<typeof column>[] = [];
  const makeColumn = (sid = 'trigger-tab') => {
    const created = column(media, sid);
    columns.push(created);
    return created;
  };
  let shortcut = name.includes('letter') ? 'Ctrl+Shift+D' : undefined;
  const baseKey = name.includes('letter') ? 'd' : ' ';
  const keyboardDispose = createRoot((cleanup) => {
    createGlobalKeyboard({
      layout: () => ({ terminal: false }) as any,
      terminalPrefs: () => ({}),
      getTerminalHandle: () => null,
      toggleTerminal() {},
      bridge: {} as any,
      setSearchModalOpen() {},
      setShortcutsOpen() {},
      voicePptShortcut: () => shortcut,
    });
    return cleanup;
  });
  const dispatch = (type: string, chord = false, repeat = false, key = baseKey) => {
    let prevented = 0;
    let stopped = 0;
    const event = {
      key,
      ctrlKey: chord,
      shiftKey: chord,
      altKey: false,
      metaKey: false,
      repeat,
      target: null,
      preventDefault: () => prevented++,
      stopPropagation: () => stopped++,
    } as unknown as KeyboardEvent;
    for (const listener of media.listeners[type] ?? []) listener(event);
    return { prevented, stopped };
  };
  const down = () => dispatch('keydown', true);
  const up = () => dispatch('keyup');
  const capture = async (entry: ReturnType<typeof column>, index: number) => {
    media.resolve(index);
    await flush();
    media.chunk(media.contexts.length - 1);
    assert.equal(entry.session.recording(), true);
  };
  try {
    const first = makeColumn();
    if (name.startsWith('unpaired') || name.includes('unrelated click')) {
      void first.session.startDictation();
      if (!name.includes('pending')) await capture(first, 0);
      if (name.startsWith('unpaired')) {
        assert.deepEqual(dispatch('keydown'), { prevented: 0, stopped: 0 });
        assert.deepEqual(up(), { prevented: 0, stopped: 0 });
      } else if (name.startsWith('blur')) media.blur();
      else keyboardDispose();
      assert.equal(first.session.capturing(), true);
      assert.equal(first.batchCalls.length, 0);
      if (name.includes('pending')) {
        assert.equal(media.acquisitions.length, 1);
        await capture(first, 0);
      }
      assert.equal(media.tracks[0].stopped, 0);
      await first.session.toggleDictation();
      assert.equal(first.session.capturing(), false);
      assert.equal(first.writes.length, 1);
      return;
    }
    if (name === 'repeat without physical press') {
      dispatch('keydown', true, true);
      assert.equal(media.acquisitions.length, 0);
      assert.deepEqual(up(), { prevented: 0, stopped: 0 });
      return;
    }
    if (name === 'chord over parked click recording') {
      void first.session.startDictation();
      await capture(first, 0);
      first.setActiveColumn(false);
      const second = makeColumn('idle-active-column');
      down();
      dispatch('keydown', true, true);
      assert.equal(media.acquisitions.length, 1);
      assert.equal(second.session.capturing(), false);
      up();
      await flush();
      assert.equal(first.session.capturing(), false);
      assert.deepEqual(first.writes, [{ sid: 'trigger-tab', text: 'batch transcript' }]);
      return;
    }
    assert.deepEqual(down(), { prevented: 1, stopped: 1 });
    assert.equal(first.session.capturing(), true);
    const pending = name.includes('pending') || name.includes('inverse microphone');
    if (!pending) await capture(first, 0);
    if (name === 'paired established release after modifiers') {
      first.sockets[0].emit('open');
      await flush();
      first.sockets[0].text('stream transcript');
    }
    if (name === 'held repeats across active column change') {
      dispatch('keydown', true, true);
      first.setActiveColumn(false);
      const second = makeColumn('next-active');
      dispatch('keydown', true, true);
      dispatch('keydown', true); // Even duplicate non-repeat delivery cannot rebind.
      assert.equal(media.acquisitions.length, 1);
      up();
      await flush();
      assert.equal(first.session.capturing(), false);
      assert.equal(second.session.capturing(), false);
      assert.equal(first.writes.length, 1);
      return;
    }
    if (name.startsWith('old ') || name.includes('replacement recording')) {
      if (name.includes('disposed')) first.dispose();
      else if (name.includes('tab-cancelled')) {
        first.setActiveSid(null);
        first.setActiveSid('trigger-tab');
      } else await first.session.toggleDictation();
      const priorWrites = first.writes.length;
      const next = name.includes('cross-column') ? makeColumn('next-column') : first;
      void next.session.startDictation();
      await capture(next, 1);
      const nextOwner = next.owners.at(-1)!;
      if (pending) {
        media.resolve(0);
        await flush();
        assert.equal(media.tracks[0].stopped, 1);
      }
      dispatch('keydown', true, true);
      assert.equal(media.acquisitions.length, 2, 'repeat never reacquires or rebinds');
      if (name.startsWith('blur')) media.blur();
      else if (name.startsWith('cleanup')) keyboardDispose();
      else assert.deepEqual(up(), { prevented: 1, stopped: 1 });
      await flush();
      assert.equal(next.session.recording(), true);
      assert.equal(media.tracks[1].stopped, 0);
      assert.equal(getActiveVoiceStream(nextOwner)?.ownerId, nextOwner);
      assert.equal(first.writes.length, priorWrites);
      assert.deepEqual(up(), { prevented: 0, stopped: 0 });
      return;
    }
    if (name.includes('while held')) {
      shortcut = name.includes('disabled') ? '' : 'Ctrl+Shift+D';
      assert.deepEqual(dispatch('keyup', false, false, 'd'), { prevented: 0, stopped: 0 });
      assert.equal(first.session.capturing(), true);
      dispatch('keydown', true, true);
      dispatch('keydown', true, false, 'd');
      assert.equal(media.acquisitions.length, 1);
    }
    if (name.startsWith('blur') || name.startsWith('hidden') || name.startsWith('cleanup')) {
      if (name.startsWith('blur')) media.blur();
      else if (name.startsWith('hidden')) media.hide();
      else keyboardDispose();
      assert.equal(first.session.capturing(), false);
      if (pending) {
        media.resolve(0);
        await flush();
      }
      assert.equal(first.writes.length, 0, 'focus loss/cleanup never authorizes a commit');
      assert.equal(first.batchCalls.length, 0);
      assert.equal(media.tracks[0].stopped, 1);
      assert.deepEqual(up(), { prevented: 0, stopped: 0 });
      if (name.startsWith('blur')) {
        down();
        assert.equal(media.acquisitions.length, 2, 'blur clears the held-key latch');
      }
      return;
    }
    if (name.includes('reentrant')) first.onBatch(() => up());
    // Modifier releases are not the captured base release and cannot end capture.
    dispatch('keyup', false, false, 'Control');
    dispatch('keyup', false, false, 'Shift');
    assert.equal(first.session.capturing(), true);
    assert.deepEqual(up(), { prevented: 1, stopped: 1 });
    assert.deepEqual(up(), { prevented: 0, stopped: 0 });
    if (name === 'paired established release after modifiers') {
      first.sockets[0].emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'transcription.done', text: 'stream transcript' })),
        false,
      );
    }
    if (pending) media.resolve(0);
    await flush();
    assert.equal(first.session.capturing(), false);
    assert.equal(media.tracks[0].stopped, 1);
    assert.equal(first.writes.length, pending ? 0 : 1);
    assert.equal(
      first.batchCalls.length,
      pending || name === 'paired established release after modifiers' ? 0 : 1,
    );
    if (pending) assert.equal(first.owners.length, 0);
    if (name.includes('while held')) {
      dispatch('keydown', true, false, 'd');
      assert.equal(media.acquisitions.length, name.includes('disabled') ? 1 : 2);
    }
  } finally {
    keyboardDispose();
    for (const entry of columns) entry.dispose();
    // Resolve late permission replies after cancellation to exercise resource fencing.
    for (let index = 0; index < media.acquisitions.length; index++) {
      if (!media.tracks[index]) media.resolve(index);
    }
    await flush();
    assert.ok(media.tracks.every((track) => track.stopped === 1));
    assert.ok(media.contexts.every((context) => context.closed));
    media.restore();
  }
}

export const cancellationAccountingScenarios = [
  '300 delayed successful replies after stop',
  '300 delayed successful replies after tab departure',
  '300 delayed successful replies after disposal',
  '300 delayed refused replies after stop',
  '300 delayed rejected replies after stop',
  '300 rejected starts while still recording',
  'cancel rejection before delivery',
  'cancel rejection after delivery',
  'persistent cancellation rejection is reported',
] as const;

export async function exerciseCancellationAccounting(
  name: (typeof cancellationAccountingScenarios)[number],
): Promise<void> {
  const media = mediaEdges();
  const columns: ReturnType<typeof column>[] = [];
  try {
    const iterations = name.startsWith('300') ? 300 : 1;
    for (let index = 0; index < iterations; index++) {
      const current = column(media);
      columns.push(current);
      const outcome = name.includes('refused')
        ? 'refused'
        : name.includes('rejected')
          ? 'rejected'
          : 'normal';
      const releaseReply = current.delayReply(outcome);
      const starting = current.session.startDictation();
      media.resolve(index);
      await flush();
      if (outcome === 'normal') {
        current.sockets[0].emit('open');
        await flush();
        assert.equal(getActiveVoiceStream(current.owners[0])?.ownerId, current.owners[0]);
      }
      if (name.includes('before delivery')) current.failCancellation('before-delivery');
      if (name.includes('after delivery')) current.failCancellation('after-delivery');
      if (name.includes('persistent')) current.failCancellation('always');
      media.chunk(index);
      if (name.includes('still recording')) {
        releaseReply();
        await starting;
      }
      if (name.includes('tab departure')) current.setActiveSid(null);
      else if (name.includes('disposal')) current.dispose();
      else await current.session.stopDictation();
      releaseReply();
      await starting;
      await flush();
      const rejectedCancel = name.includes('cancel rejection') || name.includes('persistent');
      assert.equal(
        current.cancellations.length,
        rejectedCancel ? 2 : 1,
        'one owned cancellation; only a rejected delivery permits one bounded retry',
      );
      assert.equal(new Set(current.cancellations).size, 1);
      assert.equal(current.recorder.recording, false);
      assert.equal(current.session.recording(), false);
      assert.equal(current.session.partial(), null);
      if (name.includes('persistent')) {
        assert.ok(
          current.notices.some((notice) =>
            notice.includes('Could not confirm streaming cancellation'),
          ),
        );
        assert.ok(
          getActiveVoiceStream(current.owners[0]),
          'failed delivery is not disguised as successful cleanup',
        );
        cancelActiveVoiceStream(current.owners[0]);
      } else {
        assert.equal(getActiveVoiceStream(current.owners[0]), null);
        if (outcome === 'normal') assert.equal(current.sockets[0].closed, true);
      }
      assert.equal(
        current.writes.length,
        name.includes('tab departure') || name.includes('disposal') ? 0 : 1,
      );
      current.dispose();
    }
    const next = column(media);
    columns.push(next);
    const starting = next.session.startDictation();
    media.resolve(iterations);
    await flush();
    assert.equal(
      next.sockets.length,
      1,
      'normal cancellations must not exhaust future realtime admission',
    );
    next.sockets[0].emit('open');
    await starting;
    assert.equal(next.session.partial(), '');
    next.setActiveSid(null);
    // Completed owners must not have used any unmatched-marker budget.
    // Populate its full capacity and prove a fresh admission is still allowed.
    const unmatched = Array.from({ length: MAX_PRESTART_CANCELLATIONS }, () => randomUUID());
    for (const ownerId of unmatched) cancelActiveVoiceStream(ownerId);
    const admitted = reserveVoiceStream(randomUUID());
    assert.ok(admitted.ok, 'all 256 genuine unmatched markers still fit after ordinary lifecycles');
    releaseVoiceStream(admitted.reservation);
    for (const ownerId of unmatched) assert.equal(reserveVoiceStream(ownerId).ok, false);
  } finally {
    for (const current of columns) current.dispose();
    assert.ok(media.tracks.every((track) => track.stopped === 1));
    assert.ok(media.contexts.every((context) => context.closed));
    media.restore();
  }
}

export const lifecycleScenarios = [
  'early PTT release',
  'early PTT rejection',
  'click stops pending mic',
  'pending mic tab departure',
  'pending mic disposal',
  'inverse mic resolution and old callback',
  'recorder setup failure cleanup',
  'pending stream stop',
  'pending stream tab departure',
  'pending stream disposal',
  'late stream success',
  'late stream refusal',
  'late stream rejection',
  'same-column adversarial restart',
  'cross-column adversarial restart',
  'old authorized batch completes after restart',
  'old fallback finally leaves newer transcription alone',
  'old processor callback after active restart',
  'cancel before reservation',
  'cancel during reserved settings wait',
  'bounded fail-closed cancellation admission',
] as const;

export async function exerciseVoiceLifecycle(
  name: (typeof lifecycleScenarios)[number],
): Promise<void> {
  const media = mediaEdges();
  const columns: ReturnType<typeof column>[] = [];
  const makeColumn = (sid?: string) => {
    const created = column(media, sid);
    columns.push(created);
    return created;
  };
  try {
    if (name === 'cancel before reservation') {
      const owner = randomUUID();
      cancelActiveVoiceStream(owner);
      const rejected = reserveVoiceStream(owner);
      assert.equal(rejected.ok, false);
      const next = reserveVoiceStream(randomUUID());
      assert.equal(next.ok, true);
      if (next.ok) releaseVoiceStream(next.reservation);
      return;
    }
    if (name === 'cancel during reserved settings wait') {
      const admitted = reserveVoiceStream(randomUUID());
      assert.ok(admitted.ok);
      cancelActiveVoiceStream(admitted.reservation.ownerId);
      const next = reserveVoiceStream(randomUUID());
      assert.ok(next.ok);
      assert.equal(ownsVoiceStream(admitted.reservation), false);
      releaseVoiceStream(admitted.reservation);
      assert.equal(ownsVoiceStream(next.reservation), true);
      releaseVoiceStream(next.reservation);
      return;
    }
    if (name === 'bounded fail-closed cancellation admission') {
      const owners = Array.from({ length: MAX_PRESTART_CANCELLATIONS + 1 }, () => randomUUID());
      for (const owner of owners) cancelActiveVoiceStream(owner);
      for (const owner of owners) assert.equal(reserveVoiceStream(owner).ok, false);
      assert.equal(
        reserveVoiceStream(randomUUID()).ok,
        false,
        'overflow must never reopen admission',
      );
      return;
    }
    const first = makeColumn();
    if (name.startsWith('early PTT')) {
      const keyboardDispose = createRoot((cleanup) => {
        createGlobalKeyboard({
          layout: () => ({ terminal: false }) as any,
          terminalPrefs: () => ({}),
          getTerminalHandle: () => null,
          toggleTerminal() {},
          bridge: {} as any,
          setSearchModalOpen() {},
          setShortcutsOpen() {},
        });
        return cleanup;
      });
      const dispatch = (type: string, held: boolean) =>
        media.listeners[type].forEach((listener) =>
          listener({
            key: ' ',
            ctrlKey: held,
            shiftKey: held,
            altKey: false,
            metaKey: false,
            target: null,
            preventDefault() {},
            stopPropagation() {},
          } as unknown as KeyboardEvent),
        );
      try {
        dispatch('keydown', true);
        assert.equal(first.session.capturing(), true);
        first.setActiveColumn(false);
        const second = makeColumn('second-tab');
        dispatch('keydown', true);
        assert.equal(
          media.acquisitions.length,
          1,
          'cross-column repeat cannot acquire another mic',
        );
        dispatch('keyup', false);
        assert.equal(first.session.capturing(), false);
        if (name.endsWith('rejection')) media.acquisitions[0].reject(new Error('denied'));
        else media.resolve(0);
        await flush();
        assert.equal(first.session.recording(), false);
        assert.equal(second.session.capturing(), false);
        assert.equal(first.owners.length, 0);
        assert.equal(first.notices.length, 0);
        assert.equal(first.writes.length, 0);
        if (media.tracks[0]) assert.equal(media.tracks[0].stopped, 1);
      } finally {
        keyboardDispose();
      }
      return;
    }
    const starting = first.session.startDictation();
    assert.equal(media.acquisitions.length, 1);
    void first.session.startDictation();
    assert.equal(media.acquisitions.length, 1, 'no duplicate acquisition');
    if (name === 'recorder setup failure cleanup') {
      media.failGraph();
      media.resolve(0);
      await starting;
      assert.equal(first.session.recording(), false);
      assert.equal(first.session.capturing(), false);
      assert.equal(first.notices.length, 1);
      assert.equal(first.owners.length, 0);
      assert.equal(media.tracks[0].stopped, 1);
      assert.equal(media.contexts[0].closed, true);
      return;
    }
    if (
      name === 'click stops pending mic' ||
      name === 'pending mic tab departure' ||
      name === 'pending mic disposal'
    ) {
      if (name.includes('click')) await first.session.toggleDictation();
      else if (name.includes('departure')) first.setActiveSid(null);
      else first.dispose();
      media.resolve(0);
      await starting;
      assert.equal(media.tracks[0].stopped, 1);
      assert.equal(media.contexts.length, 0);
      assert.equal(first.session.capturing(), false);
      assert.equal(first.owners.length, 0);
      assert.equal(first.writes.length, 0);
      return;
    }
    if (name === 'inverse mic resolution and old callback') {
      await first.session.stopDictation();
      const nextStart = first.session.startDictation();
      media.resolve(1);
      await flush();
      first.sockets[0].emit('open');
      await nextStart;
      media.resolve(0);
      await starting;
      assert.equal(media.tracks[0].stopped, 1);
      assert.equal(media.tracks[1].stopped, 0);
      assert.equal(media.contexts.length, 1);
      assert.equal(first.session.recording(), true);
      media.chunk(0);
      await flush();
      assert.equal(first.sockets[0].sent.filter(Buffer.isBuffer).length, 1);
      first.setActiveSid(null);
      assert.equal(media.tracks[1].stopped, 1);
      assert.equal(media.contexts[0].closed, true);
      return;
    }
    if (name.startsWith('late stream')) {
      const outcome = deferred<{ ok: boolean }>();
      // Fake IPC completion, retaining the real session and recorder lifecycle.
      first.dispose();
      let session!: ReturnType<typeof createVoiceSession>;
      const recorder = createVoiceRecorder();
      const notices: string[] = [];
      const cancelled: string[] = [];
      const dispose = createRoot((cleanup) => {
        session = createVoiceSession({
          activeSid: () => 'target-tab',
          recorder,
          onNotice: (text) => notices.push(text),
          transcribe: async () => ({ inserted: true }),
          speak: async () => ({ ok: false }),
          createAudio: () => ({}) as any,
          stream: {
            start: async () => outcome.promise,
            audio: async () => {},
            stop: async () => ({ inserted: false }),
            cancel: async (ownerId) => {
              cancelled.push(ownerId);
            },
            onPartial: () => () => {},
          },
        });
        return cleanup;
      });
      try {
        media.resolve(0);
        await starting;
        const late = session.startDictation();
        media.resolve(1);
        await flush();
        await session.stopDictation();
        const count = notices.length;
        if (name.endsWith('rejection')) outcome.reject(new Error('late rejection'));
        else outcome.resolve({ ok: name.endsWith('success') });
        await late;
        assert.equal(session.recording(), false);
        assert.equal(notices.length, count);
        assert.ok(cancelled.length >= 1);
        assert.equal(new Set(cancelled).size, 1);
        assert.equal(media.tracks[1].stopped, 1);
      } finally {
        dispose();
      }
      return;
    }
    media.resolve(0);
    await flush();
    const oldOwner = first.owners[0];
    const oldSocket = first.sockets[0];
    assert.ok(oldOwner);
    assert.ok(oldSocket);
    media.chunk(0);
    const oldCallback = media.contexts[0].processor.onaudioprocess!;
    if (
      name === 'old authorized batch completes after restart' ||
      name === 'old fallback finally leaves newer transcription alone'
    ) {
      first.holdBatch();
      const stopping = first.session.stopDictation();
      await flush();
      assert.deepEqual(first.batchCalls, ['target-tab']);
      const nextStart = first.session.startDictation();
      media.resolve(1);
      await flush();
      if (name === 'old fallback finally leaves newer transcription alone') {
        media.chunk(1);
        const nextStop = first.session.stopDictation();
        await flush();
        assert.equal(first.session.transcribing(), true);
        first.finishBatch(0);
        await stopping;
        await starting;
        assert.equal(
          first.session.transcribing(),
          true,
          'old finally cannot clear new provider work',
        );
        assert.equal(first.notices.length, 0);
        first.finishBatch(1);
        await nextStop;
        await nextStart;
        assert.equal(first.writes.length, 2);
        assert.equal(first.notices.length, 1);
        return;
      }
      first.sockets[1].emit('open');
      await nextStart;
      first.finishBatch();
      await stopping;
      await starting;
      assert.equal(first.session.recording(), true);
      assert.equal(first.session.transcribing(), false);
      assert.deepEqual(first.writes, [{ sid: 'target-tab', text: 'batch transcript' }]);
      assert.equal(first.notices.length, 0);
      return;
    }
    if (name === 'old processor callback after active restart') {
      oldSocket.emit('open');
      await starting;
      first.setActiveSid(null);
      first.setActiveSid('target-tab');
      const nextStart = first.session.startDictation();
      media.resolve(1);
      await flush();
      const nextSocket = first.sockets[1];
      nextSocket.emit('open');
      await nextStart;
      oldCallback({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
      assert.equal(nextSocket.sent.filter(Buffer.isBuffer).length, 0);
      media.chunk(1);
      await flush();
      assert.equal(nextSocket.sent.filter(Buffer.isBuffer).length, 1);
      assert.equal(media.tracks[1].stopped, 0);
      assert.equal(first.session.recording(), true);
      return;
    }
    if (name.startsWith('pending stream')) {
      if (name.endsWith('stop')) await first.session.stopDictation();
      else if (name.endsWith('departure')) first.setActiveSid(null);
      else first.dispose();
      assert.equal(media.tracks[0].stopped, 1);
      assert.equal(oldSocket.closed, true);
      assert.equal(getActiveVoiceStream(oldOwner), null);
      oldSocket.emit('open');
      oldSocket.text('stale');
      oldSocket.emit('error', new Error('late'));
      oldSocket.emit('close', 1005, Buffer.alloc(0));
      await starting;
      assert.equal(
        oldSocket.sent.length,
        0,
        'terminal cancellation sends no late configuration/audio',
      );
      assert.equal(first.writes.length, name.endsWith('stop') ? 1 : 0);
      assert.equal(first.session.recording(), false);
      assert.equal(first.session.partial(), null);
      return;
    }
    assert.ok(name.includes('adversarial restart'));
    first.setActiveSid(null);
    const next = name.startsWith('same') ? first : makeColumn('new-column-tab');
    next.setActiveSid('target-tab');
    const nextStart = next.session.startDictation();
    media.resolve(1);
    await flush();
    const newSocket = next.sockets.at(-1)!;
    const newOwner = next.owners.at(-1)!;
    assert.notEqual(newOwner, oldOwner);
    newSocket.emit('open');
    await nextStart;
    oldSocket.emit('open');
    oldSocket.text('late old caption');
    oldSocket.emit('error', new Error('late error'));
    oldSocket.emit('close', 1005, Buffer.alloc(0));
    oldCallback({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    first.session.handleAudio(oldOwner, 'AAAA');
    next.callbacks.forEach((callback) =>
      callback({ ownerId: oldOwner, sid: 'target-tab', text: 'old same-tab caption' }),
    );
    cancelActiveVoiceStream(oldOwner);
    assert.equal(takeActiveVoiceStream(oldOwner), null);
    await starting;
    assert.equal(getActiveVoiceStream(newOwner)?.ownerId, newOwner);
    assert.equal(newSocket.closed, false);
    assert.equal(newSocket.sent.filter(Buffer.isBuffer).length, 0);
    assert.equal(next.session.partial(), '');
    assert.equal(next.session.recording(), true);
    media.chunk(1);
    await flush();
    assert.equal(newSocket.sent.filter(Buffer.isBuffer).length, 1);
    newSocket.text('clean\u0000 final');
    await next.session.stopDictation();
    await next.session.stopDictation();
    assert.deepEqual(next.writes, [{ sid: 'target-tab', text: 'clean final' }]);
    assert.equal(next.batchCalls.length, 0);
  } finally {
    for (const entry of columns) entry.dispose();
    assert.ok(
      media.tracks.every((track) => track.stopped === 1),
      'every acquired track released exactly once',
    );
    assert.ok(
      media.contexts.every((context) => context.closed),
      'every constructed graph released',
    );
    media.restore();
  }
}
