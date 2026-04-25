/* Notes-tree per-subdir collapsed/expanded state.

   Each <details data-subdir-key="<slug>/<rel_dir>"> remembers its open
   state in localStorage. After every render (full reload or fragment
   swap) we walk every notes-group <details> and restore the saved
   state — defaulting to closed.

   _NOTES_OPEN_KEY is exported because uploadToNotes and
   createNotesSubdir in dashboard-main.js seed localStorage entries
   for freshly-created subdirs by hand. */

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
