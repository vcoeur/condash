/* Terminal-tab lifecycle subsystem.
   Owns tab create/close/rename, the toggle-pane shortcut entry point,
   restore-on-reload bootstrapping, and the launcher-flavoured tab path.
   Wires the per-tab xterm + pty WebSocket and routes incoming protocol
   frames into the right behaviour (info / exit / session-expired).

   Extracted from sections/tab-drag.js (former 962 LOC monolith) — the
   audit's C10 split. Companion files: sections/terminal-pointer.js
   (drag/splitter/pane-resize) and sections/terminal-shortcuts.js
   (keybindings + screenshot paste). Cross-module references stay inside
   function bodies so the cycle remains TDZ-safe — see
   notes/01-p07-tab-drag-split.md §D2 for the original design rules. */

import {
    termState,
    _termSideEl, _termTabsOn, _termActiveTab,
    _termSendResize, _termSendResizeAll, _termPersistTabs,
    _termShellLabel, _termSyncActiveSide, _termSetActive,
    _termRenderTabChip,
    _termAssetsReady, _termWarnAssets,
    _termClipboardRead, _termClipboardWrite,
} from './terminal.js';
import { _termShowSide, _termMoveActiveTabToSide } from './terminal-pointer.js';
import {
    _termShortcutSpec,
    _matchShortcut,
    pasteRecentScreenshot,
} from './terminal-shortcuts.js';

function _termDefaultLabel(tab) {
    var base = tab.shell ? (tab.shell.split('/').pop() || 'sh') : 'sh';
    return base + ' ' + tab.id;
}

function _termRefreshLabel(tab) {
    if (!tab.labelEl) return;
    tab.labelEl.textContent = tab.customName || _termDefaultLabel(tab);
}

function _termStartRename(tab) {
    if (!tab.labelEl) return;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'term-tab-rename';
    input.value = tab.customName || _termDefaultLabel(tab);
    input.style.width = Math.max(60, tab.labelEl.offsetWidth + 20) + 'px';
    var committed = false;
    var commit = function(save) {
        if (committed) return;
        committed = true;
        if (save) {
            tab.customName = input.value.trim();
            _termPersistTabs();
        }
        if (input.parentNode) {
            tab.button.insertBefore(tab.labelEl, input);
            input.parentNode.removeChild(input);
        }
        _termRefreshLabel(tab);
    };
    input.onkeydown = function(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
        ev.stopPropagation();
    };
    input.onblur = function() { commit(true); };
    input.onclick = function(ev) { ev.stopPropagation(); };
    tab.button.insertBefore(input, tab.labelEl);
    tab.button.removeChild(tab.labelEl);
    // Focus must happen *after* every requestAnimationFrame queued by the
    // two single-click handlers that preceded this double-click: each
    // click calls _termSetActive, which schedules an rAF that does
    // tab.term.focus(). A synchronous input.focus() here would lose
    // focus to xterm when those rAFs fire next frame, triggering our
    // own onblur and committing an unchanged name. Scheduling input.focus
    // via rAF parks it after the pending focus steals (rAFs run in FIFO
    // order within a frame).
    requestAnimationFrame(function() {
        input.focus();
        input.select();
    });
}

function _termCreateTab(side, opts) {
    if (!_termAssetsReady()) { _termWarnAssets(); return; }
    side = side === 'right' ? 'right' : 'left';
    opts = opts || {};
    var id = _termNextId++;
    var mount = document.createElement('div');
    mount.className = 'term-mount-session';
    _termSideEl(side, 'mount').appendChild(mount);
    // Reveal the side if it was previously empty.
    _termShowSide(side, true);
    var term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontFamily: 'ui-monospace, "SF Mono", "Menlo", monospace',
        fontSize: 13,
        theme: {background: '#0b0b0e', foreground: '#e6e6e6'},
    });
    var fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(mount);
    // When the user clicks into this pane directly, mark its side as the
    // active one so the split's accent indicator follows focus (not just
    // tab clicks, which _termSetActive already handles).
    if (term.textarea) {
        term.textarea.addEventListener('focus', function() {
            if (termState.lastFocused !== side) {
                termState.lastFocused = side;
                _termSyncActiveSide();
                _termShellLabel(tab);
            }
        });
    }
    // xterm swallows keys before they bubble. attachCustomKeyEventHandler
    // runs inside xterm's keydown listener — return false + stopPropagation
    // so our shortcut closes the pane from inside the active tab without
    // the document handler firing a second toggle.
    term.attachCustomKeyEventHandler(function(ev) {
        if (ev.type !== 'keydown') return true;
        // Toggle the pane — see comment in initTerminalShortcutsSideEffects
        // for why we both handle it here and preventDefault+stopPropagation.
        if (_termShortcutSpec.toggle && _matchShortcut(ev, _termShortcutSpec.toggle)) {
            ev.preventDefault();
            ev.stopPropagation();
            toggleTerminal();
            return false;
        }
        // Screenshot-paste shortcut. Intercept here too — xterm's keydown
        // handler runs before our document listener, and the default
        // Ctrl+Shift+V collides with the Ctrl+V clipboard branch below.
        if (_termShortcutSpec.screenshotPaste && _matchShortcut(ev, _termShortcutSpec.screenshotPaste)) {
            ev.preventDefault();
            ev.stopPropagation();
            pasteRecentScreenshot();
            return false;
        }
        // Move-active-tab shortcuts — arrow keys are otherwise consumed by
        // xterm and never bubble to the document handler.
        if (_termShortcutSpec.moveLeft && _matchShortcut(ev, _termShortcutSpec.moveLeft)) {
            ev.preventDefault();
            ev.stopPropagation();
            _termMoveActiveTabToSide('left');
            return false;
        }
        if (_termShortcutSpec.moveRight && _matchShortcut(ev, _termShortcutSpec.moveRight)) {
            ev.preventDefault();
            ev.stopPropagation();
            _termMoveActiveTabToSide('right');
            return false;
        }
        // Ctrl+C: copy the current selection if there is one, otherwise
        // let xterm send ^C (SIGINT) as normal. Ctrl+Shift+C: always copy
        // (no-op without a selection) — matches GNOME Terminal / Ghostty.
        if (ev.ctrlKey && !ev.altKey && !ev.metaKey &&
            (ev.key === 'c' || ev.key === 'C')) {
            if (ev.shiftKey || term.hasSelection()) {
                var sel = term.getSelection();
                if (sel) {
                    _termClipboardWrite(sel);
                    ev.preventDefault();
                    return false;
                }
                // Ctrl+Shift+C with no selection — swallow silently.
                if (ev.shiftKey) { ev.preventDefault(); return false; }
            }
            return true;  // fall through to SIGINT
        }
        // Ctrl+V / Ctrl+Shift+V: read clipboard via the bridge (browser
        // API if allowed, else the /clipboard server endpoint backed by
        // QClipboard). We can't rely on xterm's native paste in Qt
        // webviews because the paste event rarely fires there.
        if (ev.ctrlKey && !ev.altKey && !ev.metaKey &&
            (ev.key === 'v' || ev.key === 'V')) {
            ev.preventDefault();
            _termClipboardRead().then(function(text) {
                if (text) term.paste(text);
            });
            return false;
        }
        return true;
    });

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host + '/ws/term';
    // Reattach path: session_id binds the ws to an existing pty + replays
    // its ring buffer. Spawn path: cwd (when set) asks the server to fork
    // the new shell in that directory; it's sandbox-validated server-side
    // and silently ignored if invalid. The two are mutually exclusive —
    // cwd has no meaning when reattaching.
    if (opts.session_id) {
        wsUrl += '?session_id=' + encodeURIComponent(opts.session_id);
    } else {
        var q = [];
        if (opts.cwd) q.push('cwd=' + encodeURIComponent(opts.cwd));
        if (opts.launcher) q.push('launcher=1');
        if (q.length) wsUrl += '?' + q.join('&');
    }
    var ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    var tab = {
        id: id, side: side, term: term, fit: fit, ws: ws, mount: mount,
        shell: '', customName: opts.customName || '',
        session_id: opts.session_id || null,
    };

    ws.onopen = function() { _termSendResize(tab); };
    ws.onmessage = function(ev) {
        if (typeof ev.data === 'string') {
            try {
                var obj = JSON.parse(ev.data);
                if (obj.type === 'session-expired') {
                    // Server doesn't know this session (usually: condash
                    // restarted). Drop the stale tab so the user doesn't
                    // sit in front of an unusable pane. localStorage is
                    // rewritten by _termCloseTab → _termPersistTabs.
                    _termCloseTab(tab.id);
                } else if (obj.type === 'error' && obj.message) {
                    term.write('\r\n\x1b[31m' + obj.message + '\x1b[0m\r\n');
                } else if (obj.type === 'info') {
                    tab.session_id = obj.session_id || tab.session_id;
                    tab.shell = obj.shell || tab.shell;
                    _termRefreshLabel(tab);
                    _termPersistTabs();
                    if (termState.active[tab.side] === tab.id) _termShellLabel(tab);
                } else if (obj.type === 'exit') {
                    _termCloseTab(tab.id);
                }
            } catch (e) {}
            return;
        }
        term.write(new Uint8Array(ev.data));
    };
    ws.onclose = function() {
        // Covers both explicit exits and abnormal drops. _termCloseTab is
        // idempotent (no-op if the tab is already gone).
        _termCloseTab(tab.id);
    };
    term.onData(function(data) {
        if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
    });

    _termRenderTabChip(tab);
    termState.tabs.push(tab);
    // _termShowSide at the top of this function ran before the push, so
    // _termTabsOn(side).length was 0 for the in-flight tab on the first
    // right-side create → the splitter stayed hidden. Re-run it now that
    // the tab is counted.
    _termShowSide(side, true);
    fit.fit();
    _termSetActive(id);
    // Revealing the other side (flex 100% → flex share) shrinks any
    // existing tabs on this side too; mirror the close path's refit-all
    // so their xterm cols match the new layout.
    setTimeout(_termSendResizeAll, 0);
}

// Per-page-load monotonic tab id. Private to this module because
// _termCreateTab is the only mutator.
var _termNextId = 1;

function _termCloseTab(id) {
    var idx = termState.tabs.findIndex(function(t) { return t.id === id; });
    if (idx < 0) return;
    var tab = termState.tabs[idx];
    var side = tab.side;
    try { tab.ws.close(); } catch (e) {}
    try { tab.term.dispose(); } catch (e) {}
    if (tab.mount && tab.mount.parentNode) tab.mount.parentNode.removeChild(tab.mount);
    if (tab.button && tab.button.parentNode) tab.button.parentNode.removeChild(tab.button);
    termState.tabs.splice(idx, 1);
    var sideTabs = _termTabsOn(side);
    if (sideTabs.length === 0) {
        // This side is empty — hide it; splitter hides too.
        _termShowSide(side, false);
        termState.active[side] = null;
    } else if (termState.active[side] === id) {
        _termSetActive(sideTabs[sideTabs.length - 1].id);
    }
    if (termState.tabs.length === 0) {
        // Both sides empty — hide the pane. Next reopen spawns a fresh tab.
        var pane = document.getElementById('term-pane');
        pane.setAttribute('hidden', '');
        _termSyncOpenFlag(false);
        localStorage.removeItem('term-open');
        _termShellLabel(null);
        return;
    }
    // If the side we just closed matched the "last focused" preference,
    // flip to the other side so the header shell label follows focus.
    if (termState.lastFocused === side && sideTabs.length === 0) {
        termState.lastFocused = side === 'left' ? 'right' : 'left';
        _termShellLabel(_termActiveTab());
    }
    // Re-fit the surviving side so its xterm fills the reclaimed space.
    setTimeout(_termSendResizeAll, 0);
    _termPersistTabs();
}

function termNewTab(side) {
    var pane = document.getElementById('term-pane');
    if (pane.hasAttribute('hidden')) {
        pane.removeAttribute('hidden');
        _termSyncOpenFlag(true);
        localStorage.setItem('term-open', '1');
    }
    _termCreateTab(side || 'left');
}

/* Spawn a pty tab that runs the configured terminal.launcher_command
   (default "claude"). The server forks straight into the launcher argv
   instead of a login shell; when the process exits, the tab closes. */
function termNewLauncherTab(side) {
    // Imported lazily through the live-binding cycle — the launcher
    // command is owned by terminal-shortcuts.js and refreshed from
    // /config there.
    if (!_termLauncherCommand()) return;
    var pane = document.getElementById('term-pane');
    if (pane.hasAttribute('hidden')) {
        pane.removeAttribute('hidden');
        _termSyncOpenFlag(true);
        localStorage.setItem('term-open', '1');
    }
    var label = _termLauncherCommand().split(/\s+/)[0] || 'launcher';
    _termCreateTab(side || 'left', {launcher: true, customName: label});
}

function _termLauncherCommand() {
    // Imported here at call time to keep the cycle TDZ-safe — at module
    // top level the shortcuts module hasn't finished evaluating yet.
    return _termShortcutSpec.launcherCommand;
}

function _termSyncOpenFlag(open) {
    // Mirror the pane's visibility onto body[data-term-open] so CSS rules
    // that need to react (e.g. the note modal's bottom offset) can match
    // on an attribute selector instead of sniffing the pane's [hidden].
    if (open) document.body.setAttribute('data-term-open', '1');
    else document.body.removeAttribute('data-term-open');
}

function toggleTerminal() {
    var pane = document.getElementById('term-pane');
    var opening = pane.hasAttribute('hidden');
    if (opening) {
        pane.removeAttribute('hidden');
        _termSyncOpenFlag(true);
        localStorage.setItem('term-open', '1');
        if (termState.tabs.length === 0) _termCreateTab('left');
        setTimeout(function() {
            var tab = _termActiveTab();
            if (tab) { _termSendResize(tab); tab.term.focus(); }
        }, 0);
    } else {
        pane.setAttribute('hidden', '');
        _termSyncOpenFlag(false);
        localStorage.removeItem('term-open');
    }
}

/* Restore persisted height + open state + any live pty sessions on load.
   Runs once from initTerminalLifecycleSideEffects. Defers the actual
   tab restoration until both DOMContentLoaded and window 'load' have
   fired — xterm's `<script defer>`s aren't ready before that. */
function initTerminalLifecycleSideEffects() {
    var saved = localStorage.getItem('term-height');
    if (saved) document.documentElement.style.setProperty('--term-height', saved);
    if (localStorage.getItem('term-open') !== '1') return;

    var persisted = [];
    try {
        var raw = localStorage.getItem('term-tabs');
        if (raw) persisted = JSON.parse(raw);
        if (!Array.isArray(persisted)) persisted = [];
    } catch (e) { persisted = []; }
    var leftActive = localStorage.getItem('term-active-left') || null;
    var rightActive = localStorage.getItem('term-active-right') || null;

    document.addEventListener('DOMContentLoaded', function() {
        // Defer until xterm scripts have loaded (they use `defer`).
        window.addEventListener('load', function() {
            if (typeof Terminal === 'undefined') return;
            var pane = document.getElementById('term-pane');
            pane.removeAttribute('hidden');
            _termSyncOpenFlag(true);
            if (persisted.length === 0) {
                // No sessions recorded (fresh open, or first run after
                // this feature shipped) — preserve the old behaviour of
                // spawning one fresh left tab.
                _termCreateTab('left');
                return;
            }
            persisted.forEach(function(entry) {
                if (!entry || typeof entry !== 'object') return;
                if (!entry.session_id) return;
                _termCreateTab(entry.side === 'right' ? 'right' : 'left', {
                    session_id: entry.session_id,
                    customName: entry.customName || '',
                });
            });
            // Restore which tab is active per side. Match by session_id
            // because the in-memory `id` is assigned fresh each page load.
            termState.tabs.forEach(function(t) {
                if (!t.session_id) return;
                if (t.side === 'left' && t.session_id === leftActive) _termSetActive(t.id);
                else if (t.side === 'right' && t.session_id === rightActive) _termSetActive(t.id);
            });
        }, {once: true});
    });
}

export {
    _termDefaultLabel, _termRefreshLabel, _termStartRename,
    _termCreateTab, _termCloseTab, _termSyncOpenFlag,
    toggleTerminal, termNewTab, termNewLauncherTab,
    initTerminalLifecycleSideEffects,
};
