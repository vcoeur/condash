/* SSE event stream. Every event from /events triggers a reconcile call
   to /check-updates; the real dirty-set computation lives in
   stale-poll.js. On drop, _setReconnecting(true) surfaces the pill and
   an exponential-backoff retry loop tries to reopen. */

import { checkUpdates, _scheduleCheckUpdates } from './stale-poll.js';
import { _reconcileNoteModal } from './note-reconcile.js';

const sseState = {
    eventSource: null,
    reconnectTimer: null,
    reconnectDelay: 1000,
};

function _startEventStream() {
    if (typeof EventSource !== 'function') return;  // no push, stick with boot checkUpdates
    try {
        sseState.eventSource = new EventSource('/events');
    } catch (e) {
        _setReconnecting(true);
        _scheduleEventReconnect();
        return;
    }
    sseState.eventSource.addEventListener('hello', function() {
        _setReconnecting(false);
        sseState.reconnectDelay = 1000;
        // Reconcile: the stream may have missed changes during the
        // gap. checkUpdates diffs fingerprints and picks them up.
        checkUpdates();
    });
    sseState.eventSource.addEventListener('ping', function() { /* keepalive */ });
    // Each frame now carries a named event matching its `tab` field
    // (`projects` / `knowledge` / `code`) so htmx can trigger on a
    // specific tab via `hx-trigger="sse:projects"`. Named events bypass
    // `onmessage`, so we register a per-tab listener that funnels back
    // into the same staleness + note-reconcile pipeline as before.
    var onTabFrame = function() {
        _scheduleCheckUpdates();
        _reconcileNoteModal();
    };
    sseState.eventSource.addEventListener('projects', onTabFrame);
    sseState.eventSource.addEventListener('knowledge', onTabFrame);
    sseState.eventSource.addEventListener('code', onTabFrame);
    sseState.eventSource.onerror = function() {
        _setReconnecting(true);
        try { sseState.eventSource.close(); } catch (e) {}
        sseState.eventSource = null;
        _scheduleEventReconnect();
    };
}

function _scheduleEventReconnect() {
    if (sseState.reconnectTimer) return;
    sseState.reconnectTimer = setTimeout(function() {
        sseState.reconnectTimer = null;
        sseState.reconnectDelay = Math.min(sseState.reconnectDelay * 2, 30000);
        _startEventStream();
    }, sseState.reconnectDelay);
}

function _setReconnecting(on) {
    var pill = document.getElementById('reconnecting-pill');
    if (!pill) return;
    if (on) pill.removeAttribute('hidden');
    else pill.setAttribute('hidden', '');
}

/* Register the stream. Called from dashboard-main.js's module-init
   trailer so we know stale-poll.js + the note-reconcile function
   dashboard-main.js still owns have finished evaluating. */
function initSseSideEffects() {
    _startEventStream();
}

export {
    sseState,
    _startEventStream, _scheduleEventReconnect, _setReconnecting,
    initSseSideEffects,
};
