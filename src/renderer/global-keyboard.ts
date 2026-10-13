import { onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { LayoutState, TerminalPrefs } from '@shared/types';
import type { TerminalPaneHandle } from './terminal-pane';
import type { TerminalBridge } from './terminal-bridge';
import { matchesShortcut, parseShortcut } from './keymap';
import { pttBeginTarget, pttEndTarget } from './terminal-pane/voice-ptt-registry';
import { pttCommitMatches, resolvePttShortcut } from './ptt';

export interface GlobalKeyboardDeps {
  layout: Accessor<LayoutState>;
  terminalPrefs: () => TerminalPrefs | undefined;
  /** Read the current terminal pane handle (null until the pane is mounted). */
  getTerminalHandle: () => TerminalPaneHandle | null;
  toggleTerminal: () => void;
  bridge: TerminalBridge;
  setSearchModalOpen: (open: boolean) => void;
  setShortcutsOpen: (updater: (cur: boolean) => boolean) => void;
  /** `voice.pptShortcut` — hold-to-dictate chord (empty disables; unset →
   *  the Ctrl+Shift+Space default). Live-fired by the Settings modal. */
  voicePptShortcut?: () => string | undefined;
}

/**
 * Wires the global `keydown` listener (capture phase) covering the five
 * top-level shortcut clusters:
 *
 *   1. Pane-toggle (`Ctrl+\``) — always wins, even from inside an input.
 *   2. Screenshot-paste — wins inside the xterm too; uses `stopPropagation`
 *      to suppress xterm.js's built-in Ctrl+Shift+V text paste.
 *   3. Push-to-talk (`Ctrl+Shift+Space` by default) — wins inside the xterm
 *      too (dictation's whole point is not touching the mouse); the chord
 *      starts the ACTIVE column's recording on keydown and commits it on
 *      the base key's keyup, ignoring modifier order.
 *   4. `?` overlay + `Ctrl+K` search — yield to text inputs / xterm.
 *   5. Terminal tab move (`Ctrl+Left` / `Ctrl+Right`) — only when the pane
 *      is open.
 *
 * Capture phase: the screenshot-paste and PTT branches need to run before
 * xterm.js's textarea keydown listener so `stopPropagation` can suppress
 * its built-in handling. Other branches don't stopPropagation, so events
 * still bubble normally to descendants when no shortcut matches.
 */
export function createGlobalKeyboard(deps: GlobalKeyboardDeps): void {
  const handleGlobalKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const insideEditable = !!target?.closest(
      '.xterm-host, input, textarea, .cm-editor, [contenteditable=true]',
    );

    const prefs = deps.terminalPrefs() ?? {};
    const toggle = parseShortcut(prefs.shortcut ?? 'Ctrl+`');
    // Pane-toggle is the one shortcut that always wins, even from inside a
    // text input or the active xterm — users expect it to summon/dismiss the
    // pane unconditionally.
    if (matchesShortcut(event, toggle)) {
      event.preventDefault();
      deps.toggleTerminal();
      return;
    }

    // Screenshot-paste shortcut wins inside the xterm too — that's the very
    // surface users want to paste a screenshot path into. The listener runs
    // in capture phase (see addEventListener below), so stopPropagation here
    // keeps xterm.js from firing its built-in Ctrl+Shift+V → clipboard text
    // paste, which would otherwise win and overwrite the screenshot path.
    if (deps.layout().terminal && deps.getTerminalHandle()) {
      const screenshotPaste = parseShortcut(prefs.screenshot_paste_shortcut ?? 'Ctrl+Shift+V');
      if (matchesShortcut(event, screenshotPaste)) {
        event.preventDefault();
        event.stopPropagation();
        void deps.bridge.handleScreenshotPaste();
        return;
      }
    }

    // Push-to-talk wins inside the xterm too — dictation exists so the user
    // never touches the mouse, and the focused surface during dictation is
    // the terminal. Keydown starts (the recording guard absorbs auto-repeat);
    // the matching keyup below commits, ignoring modifier order.
    const pttChord = resolvePttShortcut(deps.voicePptShortcut?.());
    if (pttChord && matchesShortcut(event, pttChord)) {
      const target = pttBeginTarget();
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        target.begin();
        return;
      }
    }

    // Every other shortcut yields to text inputs / xterm so we don't steal
    // arrow keys, paste, etc. from someone who's typing.
    if (insideEditable) return;

    // ?-overlay toggle. Bare `?` (no modifiers) so a shifted `?` from the
    // user's keyboard layout still fires; the focused-input guard above
    // already keeps it out of any text field.
    if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      deps.setShortcutsOpen((cur) => !cur);
      return;
    }

    // Ctrl+K → open search. The Search menu item already binds
    // Ctrl+Shift+F (Electron menus accept one accelerator per item), but
    // the cheat-sheet documents Ctrl+K as the primary; bind it here so
    // muscle memory from VS Code / Linear / Slack works.
    if ((event.ctrlKey || event.metaKey) && event.key === 'k' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      deps.setSearchModalOpen(true);
      return;
    }

    // Move-tab shortcuts only fire when the pane is open.
    const handle = deps.getTerminalHandle();
    if (!deps.layout().terminal || !handle) return;
    const left = parseShortcut(prefs.move_tab_left_shortcut ?? 'Ctrl+Left');
    const right = parseShortcut(prefs.move_tab_right_shortcut ?? 'Ctrl+Right');
    if (matchesShortcut(event, left)) {
      event.preventDefault();
      handle.moveActiveTab(-1);
      return;
    }
    if (matchesShortcut(event, right)) {
      event.preventDefault();
      handle.moveActiveTab(1);
      return;
    }
  };

  // Push-to-talk commit: keyup of the chord's base key, modifiers ignored
  // (releasing Ctrl before Space must still commit). Only engages while a
  // recording is live — an ordinary Space keyup is untouched.
  const handleGlobalKeyUp = (event: KeyboardEvent): void => {
    const chord = resolvePttShortcut(deps.voicePptShortcut?.());
    if (!chord || !pttCommitMatches(event, chord)) return;
    const target = pttEndTarget();
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    target.end();
  };

  onMount(() => {
    document.addEventListener('keydown', handleGlobalKeyDown, true);
    document.addEventListener('keyup', handleGlobalKeyUp, true);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleGlobalKeyDown, true);
    document.removeEventListener('keyup', handleGlobalKeyUp, true);
  });
}
