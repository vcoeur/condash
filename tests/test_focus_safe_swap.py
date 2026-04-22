"""Smoke assertions for the focusSafeSwap primitive + Phase-2 guards.

The primitive and guards are JavaScript inside the bundled
``src/condash/assets/src/js/dashboard-main.js`` module; we can't run
them without a browser. These tests protect the contract
that the functions exist, that the default skipIf is wired, and that
the two production-landmine call sites park the request on skip
instead of silently dropping it.

When the frontend eventually grows a Playwright harness, these
assertions should migrate into real behavioural tests. Until then,
they catch the regressions that matter most (accidentally deleting
the guard, forgetting to wire the pending-reload queue).
"""

from __future__ import annotations

from pathlib import Path

DASHBOARD = Path(__file__).resolve().parent.parent / "src" / "condash" / "assets" / "dashboard.html"
DASHBOARD_JS = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "condash"
    / "assets"
    / "src"
    / "js"
    / "dashboard-main.js"
)


def _html() -> str:
    return DASHBOARD.read_text(encoding="utf-8")


def _js() -> str:
    return DASHBOARD_JS.read_text(encoding="utf-8")


def test_focus_safe_swap_defined():
    body = _js()
    assert "function focusSafeSwap(" in body
    assert "function _snapshotForSwap(" in body
    assert "function _restoreFromSnapshot(" in body


def test_default_skipif_wired():
    body = _js()
    assert "function _defaultReloadSkipIf(" in body
    assert "_noteModalDirty()" in body
    assert "_runnerActiveIn(" in body
    assert "opts.skipIf || _defaultReloadSkipIf" in body


def test_pending_reload_queue_exists():
    body = _js()
    assert "_pendingReloadNodes" in body
    assert "_pendingReloadInPlace" in body
    assert "function _flushPendingReloads(" in body


def test_reload_node_parks_on_skip():
    body = _js()
    assert "_pendingReloadNodes.add(nodeId)" in body


def test_reload_in_place_parks_on_skip():
    body = _js()
    assert "_pendingReloadInPlace = true" in body


def test_flush_triggers():
    body = _js()
    # dirty → clean transition in the note modal must flush.
    assert "_setDirty" in body
    # Close + runner-exit + runner-onclose all flush.
    assert body.count("_flushPendingReloads()") >= 3


def test_runner_guard_checks_open_websocket():
    body = _js()
    assert "WebSocket.OPEN" in body
    assert ".runner-term-mount" in body


def test_phase3_auto_reload_active_tab():
    body = _js()
    # checkUpdates must delegate to the active-tab auto-reload path.
    assert "function _autoReloadActiveTab(" in body
    assert "_autoReloadActiveTab(fresh)" in body
    # The dot is binary per-tab-header, suppressed on the active tab.
    assert "key !== _activeTab" in body


def test_phase3_per_node_dots_removed():
    body = _js()
    # The old multi-level ancestor-hint rendering is gone; only the
    # cleanup sweep for any leftover classes survives.
    assert "hintIds.add" not in body
    assert "el.appendChild(btn);" not in body
    # switchTab no longer has the "same tab + stale = refresh" branch.
    assert "if (clickedSameTab && clickedTabStale)" not in body


def test_phase4_shadow_cache_present():
    body = _js()
    assert "_shadowCache" in body
    assert "function _refreshShadowCache(" in body
    assert "function _consumeShadowCache(" in body
    # Prefetch kicked off from checkUpdates when any inactive tab is dirty.
    assert "anyInactiveDirty" in body
    # _reloadInPlace prefers the cache over re-fetching.
    assert "_consumeShadowCache()" in body


def test_phase5_search_inputs_data_preserve():
    html = _html()
    js = _js()
    # data-preserve markers live on the <input> elements in the HTML shell.
    assert 'data-preserve="condash.search.knowledge"' in html
    assert 'data-preserve="condash.search.history"' in html
    # Live writes to sessionStorage via filter functions.
    assert "_persistSearch(" in js
    # Initial page load reads sessionStorage and replays the filter.
    assert "function _restorePreservedSearches(" in js
    assert "_restorePreservedSearches();" in js


def test_phase6_event_stream_replaces_poll():
    body = _js()
    # The 5s polling loop is gone; EventSource is wired in.
    assert "setInterval(checkUpdates, 5000)" not in body
    assert "new EventSource('/events')" in body
    assert "function _startEventStream(" in body
    # Visible reconnecting indicator lives in the HTML shell.
    assert 'id="reconnecting-pill"' in _html()


def test_phase7_note_reconcile_wired():
    body = _js()
    assert "function _reconcileNoteModal(" in body
    assert "function _noteSilentReload(" in body
    assert "function _noteReconcileDismiss(" in body
    assert "function _noteReconcileReload(" in body
    # Banner element lives in the HTML shell; its CSS moved to the
    # bundled modals.css in F2 of condash-frontend-split.
    assert 'id="note-modal-external-banner"' in _html()
    modals_css = (DASHBOARD.parent / "src" / "css" / "modals.css").read_text(encoding="utf-8")
    assert ".note-modal-external-banner" in modals_css
    # SSE messages trigger the reconcile.
    assert "_reconcileNoteModal();" in body
