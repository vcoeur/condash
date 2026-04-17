"""Ported from ``conception/tools/dashboard.py``.

This module keeps the original parser, renderers, mutation helpers, and
HTTP surface semantics verbatim. The only differences from the upstream
file are:

* ``BASE_DIR`` is no longer hard-coded from ``__file__``; it is set by
  :func:`init` from the ``CondashConfig``.
* The HTML template lives inside the ``condash`` package as a resource
  and is loaded via ``importlib.resources``.
* The repositories list (primary / secondary) comes from the config, not
  from a YAML file next to the script.
* ``BaseHTTPRequestHandler`` / ``DashboardServer`` / ``main`` are removed —
  the web surface now lives in :mod:`condash.app` on top of NiceGUI /
  FastAPI. All the helpers they called (``_toggle_checkbox``,
  ``_add_step``, ``_render_note``, ``_tidy``, etc.) are still exported
  here unchanged so ``app.py`` can call them directly.
"""

from __future__ import annotations

import logging
from importlib.resources import files as _package_files
from pathlib import Path
from typing import Any

from .git_scan import (  # noqa: F401 — re-exported for backward compat during the Phase 1 split
    _collect_git_repos,
    _git_cache,
    _git_fingerprint,
    _git_status,
    _git_worktrees,
    _is_sandbox_stub,
    _load_repository_structure,
    _resolve_submodules,
)
from .mutations import (  # noqa: F401 — re-exported for backward compat during the Phase 1 split
    _KIND_MAP,
    _add_step,
    _edit_step,
    _remove_step,
    _reorder_all,
    _set_priority,
    _tidy,
    _toggle_checkbox,
    create_note,
    read_note_raw,
    rename_note,
    run_tidy,
    write_note,
)
from .openers import (  # noqa: F401 — re-exported for backward compat during the Phase 1 split
    _EXTERNAL_URL_RE,
    _is_external_url,
    _open_external,
    _open_path,
    _os_open,
    _try_pdf_viewer,
)
from .parser import (  # noqa: F401 — re-exported for backward compat during the Phase 1 split
    _IMAGE_EXTS,
    _ITEM_DIR_RE,
    _MONTH_DIR_RE,
    _PDF_EXTS,
    _TEXT_EXTS,
    CHECKBOX_RE,
    DELIVERABLE_RE,
    HEADING2_RE,
    HEADING3_RE,
    METADATA_RE,
    PRI_ORDER,
    PRIORITIES,
    STATUS_RE,
    _compute_fingerprint,
    _knowledge_node,
    _knowledge_title_and_desc,
    _list_notes,
    _note_kind,
    _parse_deliverables,
    _parse_sections,
    _tidy_needed,
    collect_items,
    collect_knowledge,
    parse_readme,
)
from .paths import (  # noqa: F401 — re-exported for backward compat during the Phase 1 split
    _ASSET_CONTENT_TYPES,
    _VALID_ASSET_RE,
    _VALID_DOWNLOAD_RE,
    _VALID_ITEM_FILE_RE,
    _VALID_KNOWLEDGE_NOTE_RE,
    _VALID_NOTE_FILENAME_RE,
    _VALID_NOTE_RE,
    _VALID_PATH_RE,
    _guess_content_type,
    _safe_resolve,
    _validate_doc_path,
    _validate_open_path,
    _validate_path,
    validate_asset_path,
    validate_download_path,
    validate_file_path,
    validate_note_path,
)
from .render import (  # noqa: F401 — re-exported for backward compat during the Phase 1 split
    _ICON_SVGS,
    _IMG_SRC_RE,
    _render_card,
    _render_deliverables,
    _render_git_actions,
    _render_git_repos,
    _render_group,
    _render_index_badge,
    _render_knowledge,
    _render_knowledge_card,
    _render_knowledge_group,
    _render_markdown,
    _render_note,
    _render_notes,
    _render_readme_link,
    _render_step,
    _render_submodule_rows,
    _rewrite_img_src,
    h,
    render_page,
)
from .wikilinks import (  # noqa: F401 — re-exported for backward compat during the Phase 1 split
    _DATE_SLUG_RE,
    _ITEM_TYPE_NORMAL,
    _WIKILINK_RE,
    _find_item_dir,
    _preprocess_wikilinks,
    _resolve_wikilink,
)

log = logging.getLogger(__name__)

# Populated by init() before any rendering / mutation function is called.
BASE_DIR: Path = Path("/nonexistent")

# Populated by init() from CondashConfig.workspace_path. ``None`` means the
# user did not configure a code workspace, and the dashboard's repo strip is
# suppressed entirely.
_WORKSPACE: Path | None = None

# Populated by init() from CondashConfig.worktrees_path. ``None`` means the
# user has no extra git-worktrees sandbox; the "open in IDE" action then
# only accepts paths inside ``_WORKSPACE``.
_WORKTREES: Path | None = None

# Populated by init() from CondashConfig.repositories_{primary,secondary}.
_REPO_STRUCTURE: list[tuple[str, list[tuple[str, list[str]]]]] = []

# Populated by init() from CondashConfig.open_with — the three vendor-neutral
# launcher slots used by the per-repo action buttons. Defaults to an empty
# dict; render_git_actions falls back to slot-key-as-title when missing.
_OPEN_WITH: dict[str, Any] = {}

# Populated by init() from CondashConfig.pdf_viewer. Fallback chain of
# shell-style commands tried for *.pdf files before falling back to the OS
# default opener. Empty list → current behaviour (xdg-open / open / startfile).
_PDF_VIEWER: list[str] = []


def init(cfg) -> None:
    """Wire runtime configuration into this module.

    Must be called exactly once before any other function. Accepts a
    :class:`condash.config.CondashConfig` (typed as ``Any`` here to avoid
    a circular import at module load).
    """
    global BASE_DIR, _WORKSPACE, _WORKTREES, _REPO_STRUCTURE, _OPEN_WITH, _PDF_VIEWER
    if cfg.conception_path is None:
        # Sentinel path that .is_dir() returns False for — collect_items
        # short-circuits to an empty list and the dashboard renders the
        # setup prompt.
        BASE_DIR = Path("/nonexistent")
    else:
        BASE_DIR = Path(cfg.conception_path).expanduser().resolve()
    _WORKSPACE = (
        Path(cfg.workspace_path).expanduser().resolve() if cfg.workspace_path is not None else None
    )
    _WORKTREES = (
        Path(cfg.worktrees_path).expanduser().resolve() if cfg.worktrees_path is not None else None
    )
    submodules = getattr(cfg, "repo_submodules", None) or {}
    _REPO_STRUCTURE = [
        (
            "Primary",
            [(name, list(submodules.get(name) or [])) for name in cfg.repositories_primary],
        ),
        (
            "Secondary",
            [(name, list(submodules.get(name) or [])) for name in cfg.repositories_secondary],
        ),
    ]
    _OPEN_WITH = dict(cfg.open_with or {})
    _PDF_VIEWER = list(getattr(cfg, "pdf_viewer", None) or [])


def _template_path() -> Path:
    return Path(str(_package_files("condash") / "assets" / "dashboard.html"))


def _favicon_bytes() -> bytes | None:
    try:
        return (_package_files("condash") / "assets" / "favicon.svg").read_bytes()
    except FileNotFoundError:
        return None
