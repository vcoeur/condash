// Push-to-talk chord matching (design note 04 §7) — pure, mic- and
// network-free, so the chord state machine is unit-testable.
//
// Two events drive one recording:
//   - keydown matching the chord STARTS dictation — but only when not
//     already recording: holding the chord fires auto-repeat keydowns, and
//     the recording guard absorbs them (the keydown match itself ignores
//     `event.repeat` on purpose, keeping the helper honest to the guard).
//   - keyup of a matched gesture's BASE key consumes its captured attempt
//     lease — modifiers are ignored, so releasing Ctrl before Space works.
//     Matching a base key alone never grants release authority.
//
// An empty `pptShortcut` parses to no shortcut at all (`parseShortcut('')`
// is null), which is the documented disable — both helpers answer false and
// the global listener never engages.

import { canonicalKey, matchesShortcut, parseShortcut } from './keymap';
import type { Shortcut } from './keymap';

/** The renderer-side default chord. `voice.pptShortcut` unset → this; the
 *  empty string → disabled (`parseShortcut('')` → null). */
export const DEFAULT_PTT_SHORTCUT = 'Ctrl+Shift+Space';

/** Resolve the configured chord: unset → the default; '' → null (disabled);
 *  otherwise the parsed spec. */
export function resolvePttShortcut(pptShortcut: string | undefined): Shortcut | null {
  return parseShortcut(pptShortcut ?? DEFAULT_PTT_SHORTCUT);
}

/** True when this keydown should START push-to-talk. `alreadyRecording` is
 *  the session's recording guard — held keys auto-repeat keydowns and are
 *  absorbed here instead of retoggling. */
export function pttStartMatches(
  event: KeyboardEvent,
  shortcut: Shortcut | null,
  alreadyRecording: boolean,
): boolean {
  if (!shortcut || alreadyRecording) return false;
  return matchesShortcut(event, shortcut);
}

/** Match a held gesture's base-key snapshot; the caller must own its lease. */
export function pttCommitMatches(event: KeyboardEvent, shortcut: Shortcut | null): boolean {
  if (!shortcut) return false;
  return canonicalKey(event.key) === shortcut.key;
}
