/* Terminal-tab pointer/layout subsystem.
   Owns the three pointer-driven gestures the embedded terminal exposes —
   chip drag (reorder + cross-pane move), split-pane width drag, and the
   pane-vertical-resize drag — plus the helpers that keep the split layout
   consistent (_termShowSide, _termApplySplitRatio).

   Companion files: sections/terminal-lifecycle.js (tab create/close/
   rename/restore) and sections/terminal-shortcuts.js (keybindings +
   screenshot paste). Cross-module references are kept inside function
   bodies so the cycles stay TDZ-safe. */

import {
    termState,
    _termSideEl, _termTabsOn, _termActiveTab,
    _termSendResizeAll, _termPersistTabs,
    _termSyncActiveSide, _termSetActive,
} from './terminal.js';

/* --- Tab drag (pointer-event based) -----------------------------------
   We implement drag with pointer events rather than the HTML5
   drag-and-drop API so the gesture stays entirely in the page —
   no native drag-image snapshotting that some embedded webviews
   handle badly.

   Flow:
     - pointerdown on chip → arm a pending drag (don't start yet, so we
       don't steal clicks / dblclicks). Capture the pointer.
     - pointermove past a small pixel threshold → actually start the
       drag: clone the chip into a floating "ghost" that follows the
       cursor, dim the original, add drop markers based on
       elementFromPoint.
     - pointerup → drop. If dragging: reparent via _termMoveTabTo. If
       not dragging (just a click): let the normal onclick run.
     - pointercancel / escape → abort cleanly.

   Cross-pane moves reparent both the chip button and the xterm mount
   DOM nodes; the pty session keeps running since it's bound to the ws,
   not the DOM. No reconnect, no scrollback loss. */

var _termChipDrag = null;  // {tab, pointerId, startX, startY, active, ghost, lastDrop}
var _TERM_DRAG_THRESHOLD_PX = 5;

function _termChipPointerDown(ev, tab) {
    // Only left mouse / primary pointer. Ignore clicks on the close × so
    // it still dismisses via its own onclick.
    if (ev.button !== undefined && ev.button !== 0) return;
    if (ev.target && ev.target.classList && ev.target.classList.contains('term-tab-close')) return;
    // Don't start a drag over the rename input.
    if (ev.target && ev.target.tagName === 'INPUT') return;
    _termChipDrag = {
        tab: tab,
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        active: false,
        ghost: null,
        lastDrop: null,
    };
    try { tab.button.setPointerCapture(ev.pointerId); } catch (e) {}
    tab.button.addEventListener('pointermove', _termChipPointerMove);
    tab.button.addEventListener('pointerup', _termChipPointerUp);
    tab.button.addEventListener('pointercancel', _termChipPointerCancel);
}

function _termChipPointerMove(ev) {
    if (!_termChipDrag || ev.pointerId !== _termChipDrag.pointerId) return;
    var dx = ev.clientX - _termChipDrag.startX;
    var dy = ev.clientY - _termChipDrag.startY;
    if (!_termChipDrag.active) {
        if (Math.hypot(dx, dy) < _TERM_DRAG_THRESHOLD_PX) return;
        _termBeginDrag();
    }
    _termChipDrag.ghost.style.left = (ev.clientX - _termChipDrag.ghostOffX) + 'px';
    _termChipDrag.ghost.style.top = (ev.clientY - _termChipDrag.ghostOffY) + 'px';
    _termUpdateDropMarkers(ev.clientX, ev.clientY);
}

function _termChipPointerUp(ev) {
    if (!_termChipDrag || ev.pointerId !== _termChipDrag.pointerId) return;
    var drag = _termChipDrag;
    _termCleanupDrag();
    if (!drag.active) return;  // Was just a click — onclick already fired.
    if (!drag.lastDrop) return;
    var d = drag.lastDrop;
    if (d.kind === 'chip' && d.target.id === drag.tab.id) return;  // drop on self
    if (d.kind === 'chip') {
        var before = d.before;
        var beforeTab = before ? d.target : _termNextTabOnSide(d.target);
        _termMoveTabTo(drag.tab, d.target.side, beforeTab);
    } else if (d.kind === 'strip') {
        _termMoveTabTo(drag.tab, d.side, null);
    }
}

function _termChipPointerCancel(ev) {
    if (!_termChipDrag || ev.pointerId !== _termChipDrag.pointerId) return;
    _termCleanupDrag();
}

function _termBeginDrag() {
    var tab = _termChipDrag.tab;
    _termChipDrag.active = true;
    // Build a floating clone that follows the cursor. pointer-events:none
    // on the ghost is critical — without it, elementFromPoint returns the
    // ghost instead of the chip/strip below the cursor.
    var rect = tab.button.getBoundingClientRect();
    var ghost = tab.button.cloneNode(true);
    ghost.classList.add('term-tab-ghost');
    ghost.style.position = 'fixed';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '9999';
    ghost.style.opacity = '0.85';
    document.body.appendChild(ghost);
    _termChipDrag.ghost = ghost;
    _termChipDrag.ghostOffX = _termChipDrag.startX - rect.left;
    _termChipDrag.ghostOffY = _termChipDrag.startY - rect.top;
    tab.button.classList.add('is-dragging');
    document.getElementById('term-tabs-left').classList.add('is-drop-target');
    document.getElementById('term-tabs-right').classList.add('is-drop-target');
}

function _termUpdateDropMarkers(x, y) {
    // Clear previous markers on every chip.
    document.querySelectorAll('.term-tab.is-drop-before, .term-tab.is-drop-after').forEach(function(el) {
        el.classList.remove('is-drop-before');
        el.classList.remove('is-drop-after');
    });
    _termChipDrag.lastDrop = null;
    var el = document.elementFromPoint(x, y);
    if (!el) return;
    var chipEl = el.closest ? el.closest('.term-tab') : null;
    if (chipEl && chipEl.classList.contains('term-tab-ghost')) chipEl = null;
    if (chipEl) {
        var id = parseInt(chipEl.dataset.tabId, 10);
        var target = termState.tabs.find(function(t) { return t.id === id; });
        if (target && target.id !== _termChipDrag.tab.id) {
            var rect = chipEl.getBoundingClientRect();
            var before = x < rect.left + rect.width / 2;
            chipEl.classList.toggle('is-drop-before', before);
            chipEl.classList.toggle('is-drop-after', !before);
            _termChipDrag.lastDrop = {kind: 'chip', target: target, before: before};
            return;
        }
    }
    var stripEl = el.closest ? el.closest('.term-tabs') : null;
    if (stripEl) {
        var side = stripEl.id === 'term-tabs-right' ? 'right' : 'left';
        _termChipDrag.lastDrop = {kind: 'strip', side: side};
    }
}

function _termCleanupDrag() {
    if (!_termChipDrag) return;
    var tab = _termChipDrag.tab;
    try { tab.button.releasePointerCapture(_termChipDrag.pointerId); } catch (e) {}
    tab.button.removeEventListener('pointermove', _termChipPointerMove);
    tab.button.removeEventListener('pointerup', _termChipPointerUp);
    tab.button.removeEventListener('pointercancel', _termChipPointerCancel);
    if (_termChipDrag.ghost && _termChipDrag.ghost.parentNode) {
        _termChipDrag.ghost.parentNode.removeChild(_termChipDrag.ghost);
    }
    tab.button.classList.remove('is-dragging');
    document.querySelectorAll('.term-tab.is-drop-before, .term-tab.is-drop-after').forEach(function(el) {
        el.classList.remove('is-drop-before');
        el.classList.remove('is-drop-after');
    });
    document.querySelectorAll('.term-tabs.is-drop-target').forEach(function(el) {
        el.classList.remove('is-drop-target');
    });
    _termChipDrag = null;
}

function _termNextTabOnSide(tab) {
    var sideTabs = _termTabsOn(tab.side);
    var idx = sideTabs.findIndex(function(t) { return t.id === tab.id; });
    if (idx < 0 || idx === sideTabs.length - 1) return null;
    return sideTabs[idx + 1];
}

/* Reparent ``tab`` into ``targetSide`` at the position before ``beforeTab``
   (null = append to end). Keeps the pty session alive, updates active/
   last-focused state, refits the xterm, and persists. */
function _termMoveTabTo(tab, targetSide, beforeTab) {
    if (!tab || !tab.button || !tab.mount) return;
    targetSide = targetSide === 'right' ? 'right' : 'left';
    var sourceSide = tab.side;
    var wasActiveOnSource = termState.active[sourceSide] === tab.id;

    // Reparent DOM: chip into target strip; mount into target mount area.
    var targetStrip = _termSideEl(targetSide, 'tabs');
    var targetMount = _termSideEl(targetSide, 'mount');
    if (!targetStrip || !targetMount) return;
    if (beforeTab && beforeTab.button && beforeTab.button.parentNode === targetStrip) {
        targetStrip.insertBefore(tab.button, beforeTab.button);
    } else {
        targetStrip.appendChild(tab.button);
    }
    if (tab.mount.parentNode !== targetMount) {
        targetMount.appendChild(tab.mount);
    }
    tab.side = targetSide;

    // Keep termState.tabs in visual order so _termPersistTabs records
    // the new layout. Remove the dragged tab, then reinsert it at its
    // new index derived from DOM sibling order within the target strip.
    var i = termState.tabs.indexOf(tab);
    if (i >= 0) termState.tabs.splice(i, 1);
    var stripChildren = Array.prototype.slice.call(targetStrip.children);
    var domIdx = stripChildren.indexOf(tab.button);
    // Map the DOM position back to an insertion index in termState.tabs:
    // walk earlier siblings, count how many are in the array (some — e.g.
    // the tab we just moved — are not in the array yet).
    var priorArrayIdx = 0;
    for (var k = 0; k < domIdx; k++) {
        var siblingId = parseInt(stripChildren[k].dataset.tabId, 10);
        var siblingPos = termState.tabs.findIndex(function(t) { return t.id === siblingId; });
        if (siblingPos >= 0) priorArrayIdx = siblingPos + 1;
    }
    termState.tabs.splice(priorArrayIdx, 0, tab);

    // Same-side reorder: keep the currently active tab selected on both
    // sides. Cross-pane move: the moved tab becomes active on its new
    // side; the source side's active slot falls back to the last
    // remaining tab (or null if empty).
    if (sourceSide !== targetSide) {
        if (wasActiveOnSource) {
            var remaining = _termTabsOn(sourceSide);
            termState.active[sourceSide] = remaining.length ? remaining[remaining.length - 1].id : null;
            if (termState.active[sourceSide] !== null) {
                var stillActive = termState.tabs.find(function(t) { return t.id === termState.active[sourceSide]; });
                if (stillActive) {
                    stillActive.mount.classList.add('active');
                    stillActive.button.classList.add('active');
                }
            }
        }
        // Clear any stale active classes on the moved tab, then activate
        // it on its new side.
        tab.mount.classList.remove('active');
        tab.button.classList.remove('active');
        _termSetActive(tab.id);
    }

    _termShowSide(sourceSide, _termTabsOn(sourceSide).length > 0);
    _termShowSide(targetSide, true);
    _termPersistTabs();
    // The moved xterm was laid out against the source side's dimensions;
    // the target side is usually a different width. Refit after the DOM
    // move settles.
    setTimeout(_termSendResizeAll, 0);
}

/* Move the currently active tab to ``targetSide`` via the Ctrl+Left /
   Ctrl+Right shortcut. No-op if no active tab or if the tab is already
   on that side (leaves within-pane ordering alone). */
function _termMoveActiveTabToSide(targetSide) {
    var tab = _termActiveTab();
    if (!tab) return;
    if (tab.side === targetSide) return;
    _termMoveTabTo(tab, targetSide, null);
}

function _termApplySplitRatio() {
    var r = parseFloat(localStorage.getItem('term-split-ratio') || '');
    var leftEl = _termSideEl('left', 'side');
    var rightEl = _termSideEl('right', 'side');
    if (isFinite(r) && r > 0 && r < 1) {
        leftEl.style.flex = r + ' 1 0';
        rightEl.style.flex = (1 - r) + ' 1 0';
    } else {
        leftEl.style.flex = '';
        rightEl.style.flex = '';
    }
}

function _termShowSide(side, show) {
    var sideEl = _termSideEl(side, 'side');
    if (show) sideEl.removeAttribute('hidden');
    else sideEl.setAttribute('hidden', '');
    // Splitter only visible when both sides are populated.
    var leftVisible = _termTabsOn('left').length > 0;
    var rightVisible = _termTabsOn('right').length > 0;
    var splitter = document.getElementById('term-splitter');
    if (leftVisible && rightVisible) {
        splitter.removeAttribute('hidden');
        // Both sides present — apply any saved split ratio.
        _termApplySplitRatio();
    } else {
        splitter.setAttribute('hidden', '');
        // Single side — clear inline flex so the lone side falls back
        // to the CSS default (flex: 1 1 0) and fills the whole .term-body.
        // Flexbox's "sum of grow factors < 1" rule would otherwise leave
        // a gap the width of the old split when the saved ratio is < 50/50
        // on the surviving side.
        _termSideEl('left', 'side').style.flex = '';
        _termSideEl('right', 'side').style.flex = '';
    }
    _termSyncActiveSide();
}

/* Split drag: adjust the flex-grow on both sides as the user drags the
   splitter. Ratio persists in localStorage so the width survives
   reloads. Clamp at 15%/85% to keep both sides usable. */
var _termSplitDrag = null;
function termSplitStart(ev) {
    var body = document.querySelector('.term-body');
    var leftEl = _termSideEl('left', 'side');
    var rightEl = _termSideEl('right', 'side');
    _termSplitDrag = {
        startX: ev.clientX,
        totalW: body.clientWidth,
        leftW: leftEl.offsetWidth,
        leftEl: leftEl,
        rightEl: rightEl,
    };
    document.addEventListener('mousemove', _termSplitMove);
    document.addEventListener('mouseup', _termSplitEnd);
    ev.preventDefault();
}
function _termSplitMove(ev) {
    if (!_termSplitDrag) return;
    var d = _termSplitDrag;
    var dx = ev.clientX - d.startX;
    var newLeft = Math.max(d.totalW * 0.15, Math.min(d.totalW * 0.85, d.leftW + dx));
    var leftRatio = newLeft / d.totalW;
    d.leftEl.style.flex = leftRatio + ' 1 0';
    d.rightEl.style.flex = (1 - leftRatio) + ' 1 0';
}
function _termSplitEnd() {
    document.removeEventListener('mousemove', _termSplitMove);
    document.removeEventListener('mouseup', _termSplitEnd);
    if (!_termSplitDrag) return;
    var leftRatio = _termSplitDrag.leftEl.offsetWidth / _termSplitDrag.totalW;
    localStorage.setItem('term-split-ratio', String(leftRatio.toFixed(3)));
    _termSplitDrag = null;
    _termSendResizeAll();
}

/* Drag-resize: adjust the --term-height CSS variable while dragging, then
   persist the final value. Separate state binding from the chip-drag
   machinery — collisions impossible at runtime (one pointer / one
   mouse-drag at a time), but keeping them apart removes the prior
   `var _termDrag = null` redeclaration that confused readers. */
var _termPaneDrag = null;
function termDragStart(ev) {
    _termPaneDrag = {startY: ev.clientY, startH: document.getElementById('term-pane').offsetHeight};
    document.addEventListener('mousemove', _termDragMove);
    document.addEventListener('mouseup', _termDragEnd);
    ev.preventDefault();
}
function _termDragMove(ev) {
    if (!_termPaneDrag) return;
    var dy = _termPaneDrag.startY - ev.clientY;
    var h = Math.max(140, Math.min(window.innerHeight - 80, _termPaneDrag.startH + dy));
    document.documentElement.style.setProperty('--term-height', h + 'px');
}
function _termDragEnd() {
    document.removeEventListener('mousemove', _termDragMove);
    document.removeEventListener('mouseup', _termDragEnd);
    if (!_termPaneDrag) return;
    _termPaneDrag = null;
    var h = document.getElementById('term-pane').offsetHeight;
    localStorage.setItem('term-height', h + 'px');
    // Must refit every tab on both sides, not just the active one: the
    // pane height change is symmetric, but _termSendResize() with no arg
    // only resizes the last-focused tab. With two sides open and the last
    // focus on the right, the left side's xterm stayed wedged at its old
    // row count (and vice versa) — looked like "left vertical resize
    // broken" to the user, because that was the side that usually wasn't
    // last-focused.
    _termSendResizeAll();
}

/* Window-resize listener — every open xterm needs a refit when the window
   itself changes size, otherwise the cell grid drifts out of sync with
   the visible pixel area. */
function initTerminalPointerSideEffects() {
    window.addEventListener('resize', function() { _termSendResizeAll(); });
}

export {
    _termChipPointerDown,
    _termMoveTabTo, _termMoveActiveTabToSide,
    _termShowSide, _termApplySplitRatio,
    termSplitStart, termDragStart,
    initTerminalPointerSideEffects,
};
