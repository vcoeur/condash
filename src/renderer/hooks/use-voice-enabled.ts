import { createSignal } from 'solid-js';
import { getBootstrap } from '../bootstrap';

export interface UseVoiceEnabled {
  /** Whether voice dictation + readback is enabled. Default off: the
   *  terminal-pane Dictate/Read controls render only while this is true,
   *  mirroring the gate in the voice IPC handlers. */
  voiceEnabled: () => boolean;
  /** Settings-modal callback after a global save. The modal owns the write;
   *  this only mirrors the on-disk value into the running UI. */
  handleVoiceEnabledChange: (next: boolean) => void;
}

/** Global voice master switch as a renderer signal. Seeded from the boot
 *  bundle and live-fired by the Settings modal — the same channel the theme,
 *  uiFonts, and cardMinWidth hooks ride. A failed bootstrap reads as off: the
 *  conservative answer for a feature whose enabled state triggers network
 *  calls and microphone access. */
export function useVoiceEnabled(): UseVoiceEnabled {
  const [voiceEnabled, setVoiceEnabled] = createSignal(false);
  void getBootstrap()
    .then((boot) => setVoiceEnabled(boot.voiceEnabled))
    .catch(() => {
      /* Stay off — see the hook docblock. */
    });
  const handleVoiceEnabledChange = (next: boolean): void => {
    setVoiceEnabled(next);
  };
  return { voiceEnabled, handleVoiceEnabledChange };
}
