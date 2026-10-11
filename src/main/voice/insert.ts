// PTY insertion for a dictated transcript.
//
// The write itself goes through the same terminal-service path as typed input
// (`writeTerminal`, the body behind the `termWrite` IPC) — dictated text is
// keystrokes as far as the shell is concerned. This module owns only the
// decision around it: empty transcript → no-op, unknown/exited session →
// no-op, everything else → one write of the sanitised text.

import { sanitizeTranscript, MAX_TRANSCRIPT_CHARS } from './transcript';

/** Liveness check injected by the caller (main resolves it against the live
 *  session map; tests pass a stub). True only for a session that can accept
 *  input. */
export type SessionLiveness = (sid: string) => boolean;

/** The terminal-service write path, injected so this stays unit-testable. */
export type TerminalWrite = (sid: string, data: string) => void;

export interface InsertOutcome {
  inserted: boolean;
  chars?: number;
  reason?: 'empty-transcript' | 'no-session';
}

/**
 * Sanitise `rawTranscript` and write it into session `sid`'s PTY input. An
 * empty transcript and a dead session are both explicit no-ops — the caller
 * surfaces `reason` as a visible notice instead of writing nothing silently.
 */
export function insertTranscript(
  sid: string,
  rawTranscript: string,
  deps: { isLive: SessionLiveness; write: TerminalWrite },
  maxChars: number = MAX_TRANSCRIPT_CHARS,
): InsertOutcome {
  const text = sanitizeTranscript(rawTranscript, maxChars);
  if (!text) return { inserted: false, reason: 'empty-transcript' };
  if (!deps.isLive(sid)) return { inserted: false, reason: 'no-session' };
  deps.write(sid, text);
  return { inserted: true, chars: text.length };
}
