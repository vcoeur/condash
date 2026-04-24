/* Notes-tree per-subdir collapsed/expanded state.

   Each <details data-subdir-key="<slug>/<rel_dir>"> remembers its open
   state in localStorage. On render (full reload, in-place reload, or
   after a card fragment swap) we walk every notes-group <details> and
   restore the saved state — defaulting to closed.

   Extracted from dashboard-main.js on 2026-04-24 (P-08 of
   conception/projects/2026-04-23-condash-frontend-extraction). The
   _NOTES_OPEN_KEY constant is re-exported because uploadToNotes and
   createNotesSubdir in dashboard-main.js seed localStorage entries for
   freshly-created subdirs by hand. The document-level toggle listener
   becomes initNotesTreeStateSideEffects(). */

const _NOTES_OPEN_KEY = 'condash:notes-open:';

function restoreNotesTreeState() {
    document.querySelectorAll('.notes-group[data-subdir-key]').forEach(function(d) {
        var key = d.getAttribute('data-subdir-key');
        var saved = null;
        try { saved = localStorage.getItem(_NOTES_OPEN_KEY + key); } catch (e) {}
        d.open = saved === 'open';
    });
}

function initNotesTreeStateSideEffects() {
    document.addEventListener('toggle', function(ev) {
        var target = ev.target;
        if (!target || !target.classList || !target.classList.contains('notes-group')) return;
        var key = target.getAttribute('data-subdir-key');
        if (!key) return;
        try {
            localStorage.setItem(_NOTES_OPEN_KEY + key, target.open ? 'open' : 'closed');
        } catch (e) {}
    }, true);
}

export {
    _NOTES_OPEN_KEY, restoreNotesTreeState, initNotesTreeStateSideEffects,
};
