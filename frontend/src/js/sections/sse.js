/* SSE side-effect bridge.

   The dashboard SSE stream (`/events`) is opened by htmx via the
   `sse-connect="/events"` attribute on `<body>` and the SSE extension
   loaded in `dashboard.html`. Per-pane `hx-trigger="sse:<tab>"`
   listeners drive the per-tab fragment refreshes directly.

   This module owns the connection-lifecycle UI plus the "any disk
   change might affect the open note modal" reconcile pass. Both hang
   off the htmx SSE events:

   - `htmx:sseOpen`    → hide the reconnecting pill
   - `htmx:sseError`   → show the reconnecting pill
   - `htmx:sseClose`   → show the reconnecting pill
   - `htmx:sseMessage` → run `_reconcileNoteModal` so the open-note
                         modal refreshes if its underlying file just
                         changed on disk. */

import { _reconcileNoteModal } from './note-reconcile.js';

function _setReconnecting(on) {
    var pill = document.getElementById('reconnecting-pill');
    if (!pill) return;
    if (on) pill.removeAttribute('hidden');
    else pill.setAttribute('hidden', '');
}

function initSseSideEffects() {
    document.body.addEventListener('htmx:sseOpen', function() {
        _setReconnecting(false);
    });
    document.body.addEventListener('htmx:sseError', function() {
        _setReconnecting(true);
    });
    document.body.addEventListener('htmx:sseClose', function() {
        _setReconnecting(true);
    });
    document.body.addEventListener('htmx:sseMessage', function() {
        _reconcileNoteModal();
    });
}

export { initSseSideEffects };
