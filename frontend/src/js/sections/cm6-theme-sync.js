/* CodeMirror 6 theme re-sync.

   When the user flips dark/light, the theme-loader script in <head>
   updates documentElement.data-theme synchronously. We watch that
   attribute and retheme the live EditorView (no remount) so the
   markdown editor picks up the new palette in the same frame.

   The MutationObserver registration is wrapped in
   initCm6ThemeSyncSideEffects() so it runs after the imported
   _cmRetheme is fully initialised. */

import { _cmRetheme } from './cm6-mount.js';

function initCm6ThemeSyncSideEffects() {
    new MutationObserver(function() {
        if (typeof _cmRetheme === 'function') _cmRetheme();
    }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
}

export { initCm6ThemeSyncSideEffects };
