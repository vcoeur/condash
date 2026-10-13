/**
 * Handler-wiring tests for the global keyboard listener — the layer the
 * pure ptt.ts helpers cannot reach.
 *
 * The review defect this pins (note 06 MINOR-1): a chord keydown while a
 * recording is already live (held-chord auto-repeat, or a chord press over a
 * click-recording) must be absorbed — preventDefault + stopPropagation — or
 * it falls through to the focused xterm's textarea and types Ctrl+Space
 * garbage into the shell. The listener registers through `document`, so the
 * tests stub a minimal document and drive the registered handlers directly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import type { LayoutState } from '@shared/types';
import type { TerminalBridge } from './terminal-bridge';
import { registerVoicePtt } from './terminal-pane/voice-ptt-registry';

interface FakeEvent extends KeyboardEvent {
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
}

function keyEvent(init: {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}): FakeEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: false,
    metaKey: false,
    repeat: init.repeat ?? false,
    target: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as FakeEvent;
}

interface KeyboardHarness {
  keydown: Listener[];
  keyup: Listener[];
  dispatchDown(event: KeyboardEvent): void;
  dispatchUp(event: KeyboardEvent): void;
  dispose(): void;
}

type Listener = (event: KeyboardEvent) => void;

/** Stub `document`, create the listener inside a Solid root, and hand back
 *  the registered handlers. Events are driven into the captured listeners —
 *  the unit under test is what the handler does with an event. */
async function createKeyboardHarness(voicePptShortcut?: string): Promise<KeyboardHarness> {
  const keydown: Listener[] = [];
  const keyup: Listener[] = [];
  vi.stubGlobal('document', {
    addEventListener: (type: string, listener: Listener) => {
      (type === 'keydown' ? keydown : keyup).push(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      const list = type === 'keydown' ? keydown : keyup;
      const i = list.indexOf(listener);
      if (i >= 0) list.splice(i, 1);
    },
  });
  const { createGlobalKeyboard } = await import('./global-keyboard');
  const dispose = createRoot((disposeRoot) => {
    createGlobalKeyboard({
      layout: () => ({ terminal: false }) as LayoutState,
      terminalPrefs: () => ({}),
      getTerminalHandle: () => null,
      toggleTerminal: () => undefined,
      bridge: {} as TerminalBridge,
      setSearchModalOpen: () => undefined,
      setShortcutsOpen: () => undefined,
      voicePptShortcut: () => voicePptShortcut,
    });
    return disposeRoot;
  });
  return {
    keydown,
    keyup,
    dispatchDown: (event) => keydown.forEach((l) => l(event)),
    dispatchUp: (event) => keyup.forEach((l) => l(event)),
    dispose: () => {
      dispose();
      vi.unstubAllGlobals();
    },
  };
}

const CHORD = { key: ' ', ctrlKey: true, shiftKey: true };

describe('global keyboard PTT wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts the recording on a matching chord keydown and absorbs the event', async () => {
    const h = await createKeyboardHarness();
    const unregister = registerVoicePtt({
      isActiveColumn: () => true,
      isRecording: () => false,
      begin: vi.fn(),
      end: vi.fn(),
    });
    const event = keyEvent(CHORD);
    h.dispatchDown(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    unregister();
    h.dispose();
  });

  it('absorbs held-chord auto-repeat keydowns while a recording is live (MINOR-1)', async () => {
    // The fix under test: begin is refused (already recording), but the
    // keydown must still never reach the focused xterm. Reverting the
    // global-keyboard.ts absorb branch turns this RED.
    const h = await createKeyboardHarness();
    const unregister = registerVoicePtt({
      isActiveColumn: () => true,
      isRecording: () => true,
      begin: vi.fn(),
      end: vi.fn(),
    });
    const repeat = keyEvent({ ...CHORD, repeat: true });
    h.dispatchDown(repeat);
    expect(repeat.preventDefault).toHaveBeenCalledTimes(1);
    expect(repeat.stopPropagation).toHaveBeenCalledTimes(1);
    unregister();
    h.dispose();
  });

  it('absorbs a chord press over a click-started recording in another column', async () => {
    const h = await createKeyboardHarness();
    // Two columns: the recording one is NOT the active column, so begin has
    // no target either — the live recording alone must absorb the chord.
    const unregisterA = registerVoicePtt({
      isActiveColumn: () => false,
      isRecording: () => true,
      begin: vi.fn(),
      end: vi.fn(),
    });
    const unregisterB = registerVoicePtt({
      isActiveColumn: () => true,
      isRecording: () => false,
      begin: vi.fn(),
      end: vi.fn(),
    });
    const event = keyEvent(CHORD);
    h.dispatchDown(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    unregisterA();
    unregisterB();
    h.dispose();
  });

  it('leaves unmatched keydowns untouched in every state', async () => {
    const h = await createKeyboardHarness();
    const unregister = registerVoicePtt({
      isActiveColumn: () => true,
      isRecording: () => true,
      begin: vi.fn(),
      end: vi.fn(),
    });
    const event = keyEvent({ key: 'x' });
    h.dispatchDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    unregister();
    h.dispose();
  });

  it('commits the live recording on the base-key keyup and absorbs the event', async () => {
    const h = await createKeyboardHarness();
    const end = vi.fn();
    const unregister = registerVoicePtt({
      isActiveColumn: () => true,
      isRecording: () => true,
      begin: vi.fn(),
      end,
    });
    const event = keyEvent({ key: ' ' });
    h.dispatchUp(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    unregister();
    h.dispose();
  });

  it('never engages when the chord is disabled (empty pref)', async () => {
    const h = await createKeyboardHarness('');
    const unregister = registerVoicePtt({
      isActiveColumn: () => true,
      isRecording: () => false,
      begin: vi.fn(),
      end: vi.fn(),
    });
    const event = keyEvent(CHORD);
    h.dispatchDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    unregister();
    h.dispose();
  });

  it('unregisters the listeners on disposal', async () => {
    const h = await createKeyboardHarness();
    expect(h.keydown).toHaveLength(1);
    expect(h.keyup).toHaveLength(1);
    h.dispose();
    expect(h.keydown).toHaveLength(0);
    expect(h.keyup).toHaveLength(0);
  });
});
