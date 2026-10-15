// Per-column push-to-talk registry (design note 04 §7): each mounted
// VoiceControls registers one entry on mount and unregisters on cleanup,
// exactly mirroring the per-column mount of the controls. The global
// keyboard handler asks the registry which entry to drive — no session is
// hoisted or refactored across columns.

import type { VoiceDictationLease } from './voice-session';

export interface VoicePttEntry {
  /** This column is the app's active terminal column (the PTT keydown
   *  starts HERE, not in whichever column happens to be recording). */
  isActiveColumn(): boolean;
  /** Pending microphone acquisition or recording, preferred at gesture acquisition. */
  isRecording(): boolean;
  acquire(): VoiceDictationLease | null;
}

const entries = new Set<VoicePttEntry>();

/** Register one column's entry. Returns the unregister function. */
export function registerVoicePtt(entry: VoicePttEntry): () => void {
  entries.add(entry);
  return () => entries.delete(entry);
}

/** Acquire an existing capture before starting the active column, once per gesture. */
export function acquireVoicePtt(): VoiceDictationLease | null {
  for (const entry of entries) {
    if (entry.isRecording()) return entry.acquire();
  }
  for (const entry of entries) {
    if (entry.isActiveColumn()) return entry.acquire();
  }
  return null;
}
