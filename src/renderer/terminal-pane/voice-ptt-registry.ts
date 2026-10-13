// Per-column push-to-talk registry (design note 04 §7): each mounted
// VoiceControls registers one entry on mount and unregisters on cleanup,
// exactly mirroring the per-column mount of the controls. The global
// keyboard handler asks the registry which entry to drive — no session is
// hoisted or refactored across columns.

export interface VoicePttEntry {
  /** This column is the app's active terminal column (the PTT keydown
   *  starts HERE, not in whichever column happens to be recording). */
  isActiveColumn(): boolean;
  /** This column's session is currently recording (the keyup commits the
   *  one recording that is live, whichever column started it). */
  isRecording(): boolean;
  begin(): void;
  end(): void;
}

const entries = new Set<VoicePttEntry>();

/** Register one column's entry. Returns the unregister function. */
export function registerVoicePtt(entry: VoicePttEntry): () => void {
  entries.add(entry);
  return () => entries.delete(entry);
}

/** The column PTT should start in: the active column, provided it is not
 *  already recording (the recording guard lives in the session; a held key
 *  auto-repeating must not retoggle it). */
export function pttBeginTarget(): VoicePttEntry | null {
  for (const entry of entries) {
    if (entry.isActiveColumn()) {
      return entry.isRecording() ? null : entry;
    }
  }
  return null;
}

/** The column whose recording a keyup commits — any live recording wins,
 *  regardless of which column started it (one recording state machine, two
 *  triggers). */
export function pttEndTarget(): VoicePttEntry | null {
  for (const entry of entries) {
    if (entry.isRecording()) return entry;
  }
  return null;
}
