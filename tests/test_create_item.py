"""Tests for the ``create_item`` scaffolder behind POST /api/items.

The header "New item" button relies on this helper to write a valid
README + ``notes/`` sibling, touch the dirty marker, and reject bad
input before any bytes hit disk.
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path

import pytest

from condash.context import build_ctx
from condash.mutations import create_item


@pytest.fixture
def ctx(cfg):
    return build_ctx(cfg)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_create_project_writes_readme_notes_and_dirty_marker(ctx, tmp_conception):
    result = create_item(
        ctx,
        title="Helio benchmark harness",
        slug="helio-benchmark-harness",
        kind="project",
        status="now",
        apps="helio, helio-docs",
        today=_dt.date(2026, 4, 19),
    )
    assert result["ok"] is True
    assert result["slug"] == "helio-benchmark-harness"
    assert result["folder_name"] == "2026-04-19-helio-benchmark-harness"
    assert result["month"] == "2026-04"
    assert result["priority"] == "now"
    assert result["rel_path"] == ("projects/2026-04/2026-04-19-helio-benchmark-harness/README.md")

    item_dir = tmp_conception / "projects/2026-04/2026-04-19-helio-benchmark-harness"
    assert item_dir.is_dir()
    assert (item_dir / "notes").is_dir()
    readme = _read(item_dir / "README.md")
    assert readme.startswith("# Helio benchmark harness\n")
    assert "**Date**: 2026-04-19" in readme
    assert "**Kind**: project" in readme
    assert "**Status**: now" in readme
    assert "**Apps**: `helio`, `helio-docs`" in readme
    assert "## Goal" in readme
    assert "## Timeline" in readme

    dirty = tmp_conception / "projects/.index-dirty"
    assert dirty.exists(), "create_item must touch projects/.index-dirty"


def test_create_incident_includes_environment_and_severity(ctx, tmp_conception):
    result = create_item(
        ctx,
        title="Login 500s under concurrent load",
        slug="login-500s",
        kind="incident",
        status="now",
        apps="vcoeur.com",
        environment="PROD",
        severity="high",
        today=_dt.date(2026, 4, 19),
    )
    assert result["ok"] is True
    readme = _read(tmp_conception / "projects/2026-04/2026-04-19-login-500s/README.md")
    assert "**Kind**: incident" in readme
    assert "**Environment**: PROD" in readme
    assert "**Severity**: high" in readme
    assert "## Symptoms" in readme
    assert "## Root cause" in readme


def test_create_document_with_languages(ctx, tmp_conception):
    result = create_item(
        ctx,
        title="GDPR audit 2026",
        slug="gdpr-audit-2026",
        kind="document",
        status="review",
        apps="notes.vcoeur.com",
        languages="fr, en",
        today=_dt.date(2026, 4, 19),
    )
    assert result["ok"] is True
    readme = _read(tmp_conception / "projects/2026-04/2026-04-19-gdpr-audit-2026/README.md")
    assert "**Kind**: document" in readme
    assert "**Languages**: fr, en" in readme
    assert "## Deliverables" in readme


def test_empty_languages_omits_row_from_document(ctx, tmp_conception):
    result = create_item(
        ctx,
        title="Plugin API proposal",
        slug="plugin-api-proposal",
        kind="document",
        status="now",
        apps="helio",
        today=_dt.date(2026, 4, 19),
    )
    assert result["ok"] is True
    readme = _read(tmp_conception / "projects/2026-04/2026-04-19-plugin-api-proposal/README.md")
    assert "**Languages**" not in readme


def test_apps_optional(ctx, tmp_conception):
    result = create_item(
        ctx,
        title="No apps yet",
        slug="no-apps",
        kind="project",
        status="backlog",
        apps="",
        today=_dt.date(2026, 4, 19),
    )
    assert result["ok"] is True
    readme = _read(tmp_conception / "projects/2026-04/2026-04-19-no-apps/README.md")
    assert "**Apps**" not in readme


@pytest.mark.parametrize(
    "bad_slug",
    [
        "Has-Capital",
        "has space",
        "has_under",
        "-leading",
        "trailing-",
        "double--hyphen",
        "",
        "has.dot",
    ],
)
def test_reject_bad_slug(ctx, bad_slug):
    result = create_item(
        ctx,
        title="Title",
        slug=bad_slug,
        kind="project",
        status="now",
        today=_dt.date(2026, 4, 19),
    )
    assert result == {
        "ok": False,
        "reason": "slug must be lowercase letters, digits, and single hyphens",
    }


def test_reject_unknown_kind(ctx):
    result = create_item(
        ctx,
        title="Title",
        slug="valid-slug",
        kind="blogpost",
        status="now",
        today=_dt.date(2026, 4, 19),
    )
    assert result["ok"] is False
    assert "kind must be one of" in result["reason"]


def test_reject_unknown_status(ctx):
    result = create_item(
        ctx,
        title="Title",
        slug="valid-slug",
        kind="project",
        status="wip",
        today=_dt.date(2026, 4, 19),
    )
    assert result["ok"] is False
    assert "status must be one of" in result["reason"]


def test_reject_empty_title(ctx):
    result = create_item(
        ctx,
        title="   ",
        slug="valid-slug",
        kind="project",
        status="now",
        today=_dt.date(2026, 4, 19),
    )
    assert result == {"ok": False, "reason": "title required"}


def test_reject_bad_incident_environment(ctx):
    result = create_item(
        ctx,
        title="Title",
        slug="valid-slug",
        kind="incident",
        status="now",
        environment="LOCAL",
        today=_dt.date(2026, 4, 19),
    )
    assert result["ok"] is False
    assert "environment must be one of" in result["reason"]


def test_collision_returns_ok_false(ctx, tmp_conception):
    first = create_item(
        ctx,
        title="First",
        slug="shared-slug",
        kind="project",
        status="now",
        today=_dt.date(2026, 4, 19),
    )
    assert first["ok"] is True
    second = create_item(
        ctx,
        title="Second",
        slug="shared-slug",
        kind="project",
        status="now",
        today=_dt.date(2026, 4, 19),
    )
    assert second == {"ok": False, "reason": "item with this slug already exists today"}
    # Original README must be untouched.
    readme = _read(tmp_conception / "projects/2026-04/2026-04-19-shared-slug/README.md")
    assert readme.startswith("# First\n")


def test_creates_month_directory_when_missing(ctx, tmp_conception):
    # tmp_conception seeds 2026-01 only; picking a May date forces a new
    # month dir. create_item should create it without help.
    assert not (tmp_conception / "projects/2026-05").exists()
    result = create_item(
        ctx,
        title="May item",
        slug="may-item",
        kind="project",
        status="soon",
        today=_dt.date(2026, 5, 3),
    )
    assert result["ok"] is True
    assert (tmp_conception / "projects/2026-05/2026-05-03-may-item/README.md").exists()
