"""Dashboard smoke flows driven against the Rust build — Phase 2 exit gate.

Phase 2 of the Rust + Tauri port delivered the read-only HTTP surface
(``/``, ``/fragment``, ``/check-updates``, ``/search-history``, assets)
served by axum on top of ``condash-render`` / ``condash-state``. These
tests drive the same browser flows as ``test_dashboard_smoke`` but point
Playwright at ``condash-serve`` (the headless Rust binary) instead of
the Python process.

Scope is deliberately narrower than the Python suite:

- ``test_add_step`` lives in the Python-only suite because ``/add-step``
  is Phase 3 (mutations) territory.
- ``test_open_terminal`` likewise — the terminal pane is driven by the
  runner/PTY endpoints (``/shortcuts``, ``/runner-config``, …) that the
  Rust build 404s today; those ship in Phase 4.

The four flows kept here all exercise pieces Phase 2 is meant to ship:

1. dashboard HTML served at ``/`` (render + cache + ctx wiring),
2. card expand (pure client-side JS, proves the bundle + HTML shipped),
3. config modal open (same — different JS path),
4. ``/check-updates`` + ``/search-history`` routes return structured data.
"""

from __future__ import annotations

from playwright.sync_api import Page, expect

from .conftest import CondashServer

SEED_SLUG = "2026-01-01-e2e-demo"


def test_dashboard_loads(condash_rust_server: CondashServer, page: Page) -> None:
    page.goto(condash_rust_server.url + "/")
    expect(page).to_have_title("Conception Dashboard")
    expect(page.locator(f'[id="{SEED_SLUG}"]')).to_be_visible()


def test_open_item_card(condash_rust_server: CondashServer, page: Page) -> None:
    page.goto(condash_rust_server.url + "/")
    card = page.locator(f'[id="{SEED_SLUG}"]')
    expect(card).to_have_class("card collapsed")
    card.locator(".card-header-left").click()
    expect(card).not_to_have_class("card collapsed")
    expect(card.locator(".card-body")).to_be_visible()


def test_open_config_modal(condash_rust_server: CondashServer, page: Page) -> None:
    page.goto(condash_rust_server.url + "/")
    modal = page.locator("#config-modal")
    expect(modal).to_be_hidden()
    page.locator("button.config-toggle").click()
    expect(modal).to_be_visible(timeout=5000)


def test_readonly_routes(condash_rust_server: CondashServer, page: Page) -> None:
    """``/check-updates`` + ``/search-history`` — the two Phase 2 JSON routes.

    The fingerprint shape and the hit list are both produced by
    ``condash-state`` / ``condash-render`` working together on the
    seeded corpus; a 200 + well-formed JSON here means every step of
    the Phase 2 pipeline is reachable end-to-end.
    """
    check = page.request.get(condash_rust_server.url + "/check-updates")
    assert check.ok, f"/check-updates → {check.status}"
    body = check.json()
    assert "fingerprint" in body, body
    assert isinstance(body.get("nodes"), dict) and body["nodes"], body
    seed_node = "projects/now/2026-01-01-e2e-demo"
    assert seed_node in body["nodes"], f"seed project missing from fingerprints: {body['nodes']}"

    search = page.request.get(condash_rust_server.url + "/search-history?q=demo")
    assert search.ok, f"/search-history → {search.status}"
    html = search.text()
    # The seed project title includes "demo"; the history fragment lists it.
    assert "E2E demo project" in html, html[:500]
