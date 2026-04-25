/* Terminal-tab keybinding + screenshot-paste subsystem.
   Owns the four configurable shortcuts (toggle pane, screenshot paste,
   move-active-tab-left/right) and the launcher-command toggle. Exposes
   the parsed-spec map as a live binding so the lifecycle module's
   per-xterm key handler can read the current values without importing
   each spec individually.

   Companion files: sections/terminal-pointer.js (drag/splitter/
   pane-resize) and sections/terminal-lifecycle.js (tab create/close/
   rename/restore). Cross-module references stay inside function
   bodies so the cycles remain TDZ-safe. */

import { _termActiveTab, termState } from './terminal.js';
import {
    toggleTerminal, _termCreateTab, _termSyncOpenFlag,
} from './terminal-lifecycle.js';
import { _termMoveActiveTabToSide } from './terminal-pointer.js';

/* Parse a shortcut spec like "Ctrl+`" / "Ctrl+Shift+T" / "Alt+K" into a
   comparison object. Returns null on malformed input so we can bail
   instead of binding a bogus handler. */
function _parseShortcut(spec) {
    if (!spec || typeof spec !== 'string') return null;
    var parts = spec.split('+').map(function(s){return s.trim();}).filter(Boolean);
    if (!parts.length) return null;
    var mods = {ctrl: false, shift: false, alt: false, meta: false};
    var key = null;
    parts.forEach(function(p) {
        var low = p.toLowerCase();
        if (low === 'ctrl' || low === 'control') mods.ctrl = true;
        else if (low === 'shift') mods.shift = true;
        else if (low === 'alt' || low === 'option') mods.alt = true;
        else if (low === 'meta' || low === 'cmd' || low === 'command' || low === 'super') mods.meta = true;
        else key = p;
    });
    if (!key) return null;
    return {
        ctrl: mods.ctrl, shift: mods.shift, alt: mods.alt, meta: mods.meta,
        // Normalise single chars to lower-case; leave named keys as-is.
        key: key.length === 1 ? key.toLowerCase() : key,
    };
}

function _matchShortcut(ev, spec) {
    if (!spec) return false;
    if (ev.ctrlKey !== spec.ctrl) return false;
    if (ev.shiftKey !== spec.shift) return false;
    if (ev.altKey !== spec.alt) return false;
    if (ev.metaKey !== spec.meta) return false;
    var k = ev.key;
    return (k && k.length === 1 ? k.toLowerCase() : k) === spec.key;
}

/* Live shortcut state. The spec map is mutable so `_loadTermShortcuts`
   can refresh it whenever /config changes; importers see the new values
   via the imported binding's reference into this object. */
const _termShortcutSpec = {
    toggle: null,
    screenshotPaste: null,
    moveLeft: null,
    moveRight: null,
    launcherCommand: '',
};

async function _loadTermShortcuts() {
    try {
        var res = await fetch('/config');
        if (!res.ok) return;
        var cfg = await res.json();
        var term = cfg.terminal || {};
        _termShortcutSpec.toggle = _parseShortcut(term.shortcut || 'Ctrl+`');
        _termShortcutSpec.screenshotPaste = _parseShortcut(term.screenshot_paste_shortcut || 'Ctrl+Shift+V');
        _termShortcutSpec.moveLeft = _parseShortcut(term.move_tab_left_shortcut || 'Ctrl+Left');
        _termShortcutSpec.moveRight = _parseShortcut(term.move_tab_right_shortcut || 'Ctrl+Right');
        _termShortcutSpec.launcherCommand = (term.launcher_command || '').trim();
        _termSyncLauncherButtons();
    } catch (e) {}
}

/* Show or hide the per-side launcher "+" buttons based on whether the
   config has a non-empty launcher_command. Runs on config load and on
   every /config POST that goes through this page. */
function _termSyncLauncherButtons() {
    var show = !!_termShortcutSpec.launcherCommand;
    ['left', 'right'].forEach(function(side) {
        var btn = document.getElementById('term-launcher-' + side);
        if (!btn) return;
        if (show) {
            btn.removeAttribute('hidden');
            var label = _termShortcutSpec.launcherCommand.split(/\s+/)[0] || 'launcher';
            btn.title = 'New ' + label + ' tab (' + side + ')';
            btn.setAttribute('aria-label', btn.title);
        } else {
            btn.setAttribute('hidden', '');
        }
    });
}

/* Lightweight transient banner shown by keyboard-shortcut actions that
   don't have a button to flash. Reuses one DOM node — multiple calls
   restart the visibility timer rather than stacking. */
var _toastTimer = null;
function _showToast(msg, opts) {
    var el = document.getElementById('shortcut-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'shortcut-toast';
        el.className = 'shortcut-toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('is-err', !!(opts && opts.error));
    // Force reflow so the opacity transition replays on rapid re-fires.
    void el.offsetWidth;
    el.classList.add('is-visible');
    if (_toastTimer) clearTimeout(_toastTimer);
    var ms = (opts && opts.ms) || 1800;
    _toastTimer = setTimeout(function() {
        el.classList.remove('is-visible');
    }, ms);
}

/* Look up the most recent screenshot path server-side and inject it into
   the active terminal tab — no Enter, the user confirms. Mirrors workOn():
   if no tab is open, open the pane + spawn one and poll until ws is ready.
   Surfaces errors via a transient toast since there's no button to flash. */
async function pasteRecentScreenshot() {
    var info;
    try {
        var res = await fetch('/recent-screenshot');
        info = await res.json();
        if (!res.ok) {
            _showToast((info && info.error) || ('HTTP ' + res.status), {error: true});
            return;
        }
    } catch (e) {
        _showToast('Could not query screenshot directory', {error: true});
        return;
    }
    if (!info.path) {
        var dirNote = info.dir ? ' (' + info.dir + ')' : '';
        _showToast('No screenshot found' + dirNote + (info.reason ? ' — ' + info.reason : ''), {error: true});
        return;
    }
    var text = info.path;
    var active = _termActiveTab();
    if (active && active.ws && active.ws.readyState === WebSocket.OPEN) {
        active.ws.send(new TextEncoder().encode(text));
        active.term.focus();
        return;
    }
    var pane = document.getElementById('term-pane');
    if (pane.hasAttribute('hidden')) {
        pane.removeAttribute('hidden');
        _termSyncOpenFlag(true);
        localStorage.setItem('term-open', '1');
    }
    if (termState.tabs.length === 0) _termCreateTab('left');
    var tries = 0;
    (function trySend() {
        var tab = _termActiveTab();
        if (tab && tab.ws && tab.ws.readyState === WebSocket.OPEN) {
            tab.ws.send(new TextEncoder().encode(text));
            tab.term.focus();
            return;
        }
        if (++tries < 40) setTimeout(trySend, 75);
    })();
}

function initTerminalShortcutsSideEffects() {
    document.addEventListener('keydown', function(ev) {
        var inEditable = ev.target && (ev.target.tagName === 'INPUT' ||
                                       ev.target.tagName === 'TEXTAREA' ||
                                       ev.target.isContentEditable);
        if (_termShortcutSpec.toggle) {
            var hasModifier = _termShortcutSpec.toggle.ctrl || _termShortcutSpec.toggle.alt || _termShortcutSpec.toggle.meta;
            if (!(inEditable && !hasModifier) && _matchShortcut(ev, _termShortcutSpec.toggle)) {
                ev.preventDefault();
                toggleTerminal();
                return;
            }
        }
        if (_termShortcutSpec.screenshotPaste) {
            var hasMod = _termShortcutSpec.screenshotPaste.ctrl || _termShortcutSpec.screenshotPaste.alt || _termShortcutSpec.screenshotPaste.meta;
            // The default Ctrl+Shift+V collides with xterm's paste — that
            // handler is registered inside attachCustomKeyEventHandler and
            // fires first, so we'd never see the event. Catch it here at the
            // capture phase below instead. For non-terminal targets the bubble
            // phase is fine, so we still listen here.
            if (!(inEditable && !hasMod) && _matchShortcut(ev, _termShortcutSpec.screenshotPaste)) {
                ev.preventDefault();
                pasteRecentScreenshot();
                return;
            }
        }
        if (_termShortcutSpec.moveLeft && _matchShortcut(ev, _termShortcutSpec.moveLeft)) {
            if (!inEditable || _termShortcutSpec.moveLeft.ctrl || _termShortcutSpec.moveLeft.alt || _termShortcutSpec.moveLeft.meta) {
                ev.preventDefault();
                _termMoveActiveTabToSide('left');
                return;
            }
        }
        if (_termShortcutSpec.moveRight && _matchShortcut(ev, _termShortcutSpec.moveRight)) {
            if (!inEditable || _termShortcutSpec.moveRight.ctrl || _termShortcutSpec.moveRight.alt || _termShortcutSpec.moveRight.meta) {
                ev.preventDefault();
                _termMoveActiveTabToSide('right');
                return;
            }
        }
    });

    _loadTermShortcuts();
}

export {
    _termShortcutSpec,
    _matchShortcut, _parseShortcut,
    _loadTermShortcuts,
    pasteRecentScreenshot,
    initTerminalShortcutsSideEffects,
};
